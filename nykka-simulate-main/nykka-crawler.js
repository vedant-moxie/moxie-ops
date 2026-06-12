import { PlaywrightCrawler, Dataset, log } from 'crawlee';
import { firefox } from 'playwright';
import { launchOptions } from 'camoufox-js';
import { google } from "googleapis";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// --- Path & Environment Setup ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];
const TOKEN_PATH = path.join(__dirname, "gmail-token.json");
const CREDENTIALS_PATH = path.join(__dirname, "gmail-credentials.json");

let globalAuthClient = null;

// --- 1. Gmail API Helpers ---

async function authorize() {
    let credentials;
    try {
        credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
    } catch (err) {
        throw new Error("Missing gmail-credentials.json. Please download from Google Cloud Console.");
    }

    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    try {
        const token = fs.readFileSync(TOKEN_PATH, "utf8");
        oAuth2Client.setCredentials(JSON.parse(token));
        return oAuth2Client;
    } catch (err) {
        // Note: For a server/headless environment, you should handle the OAuth flow 
        // manually once locally to generate the gmail-token.json.
        throw new Error("Gmail token missing or expired. Run local auth flow first.");
    }
}

function extractOTP(emailBody) {
    const patterns = [
        /\b(\d{6})\b/g,
        /OTP[:\s]+(\d+)/gi,
        /code[:\s]+(\d+)/gi,
        /verification code[:\s]+(\d+)/gi,
    ];
    for (const pattern of patterns) {
        const matches = emailBody.match(pattern);
        if (matches && matches.length > 0) {
            const otp = matches[0].replace(/\D/g, "");
            if (otp.length >= 4 && otp.length <= 6) return otp;
        }
    }
    return null;
}

async function fetchOTPFromGmail(auth, searchQuery) {
    const gmail = google.gmail({ version: "v1", auth });
    const searchQueryWithTime = `${searchQuery} newer_than:1m`;
    
    const res = await gmail.users.messages.list({ userId: "me", q: searchQueryWithTime, maxResults: 3 });
    const messages = res.data.messages;
    if (!messages || messages.length === 0) return null;

    for (const message of messages) {
        const msg = await gmail.users.messages.get({ userId: "me", id: message.id, format: "full" });
        
        const getBody = (payload) => {
            let body = "";
            if (payload.body?.data) body += Buffer.from(payload.body.data, "base64").toString("utf-8");
            if (payload.parts) payload.parts.forEach(part => body += getBody(part));
            return body;
        };

        const emailBody = getBody(msg.data.payload);
        const subject = msg.data.payload.headers.find(h => h.name === "Subject")?.value || "";
        const otp = extractOTP(emailBody + " " + subject);
        if (otp) return otp;
    }
    return null;
}

async function waitForOTP(auth, searchQuery, timeoutMs = 120000, pollIntervalMs = 5000) {
    const startTime = Date.now();
    log.info("Waiting for email delivery (15s buffer)...");
    await new Promise(res => setTimeout(res, 15000));

    while (Date.now() - startTime < timeoutMs) {
        const otp = await fetchOTPFromGmail(auth, searchQuery);
        if (otp) return otp;
        log.info(`OTP not found yet, retrying in ${pollIntervalMs / 1000}s...`);
        await new Promise(res => setTimeout(res, pollIntervalMs));
    }
    return null;
}

// --- 2. Crawlee Implementation ---

const crawler = new PlaywrightCrawler({
    launchContext: {
        launcher: firefox, // Camoufox is Firefox-based
        launchOptions: await launchOptions({
            headless: true, // Set to true for background runs
        }),
    },
    requestHandlerTimeoutSecs: 240, // High timeout to account for OTP delays
    maxRequestRetries: 1,

    async requestHandler({ page, request, log }) {
        const { email } = request.userData;

        log.info(`Navigating to Nykaa Seller Login...`);
        await page.goto(request.url, { waitUntil: 'domcontentloaded' });

        // Email Phase
        await page.waitForSelector('input[name="email"]');
        await page.fill('input[name="email"]', email);
        await page.click('button[aria-label="Login to Nykaa"]');

        // OTP Phase
        log.info('Waiting for OTP input fields to appear on-page...');
        await page.waitForSelector('.input-component__input.no-label-input', { timeout: 45000 });

        log.info('Starting Gmail polling...');
        const otp = await waitForOTP(globalAuthClient, "from:noreply@nykaa.com subject:Verification Code");

        if (!otp) throw new Error("Timed out waiting for OTP from Gmail.");

        log.info(`Entering OTP: ${otp}`);
        const otpInputs = await page.$$('.input-component__input.no-label-input');
        for (let i = 0; i < otp.length; i++) {
            await otpInputs[i].fill(otp[i]);
        }

        // Verification Phase
        log.info('Verifying OTP...');
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle' }),
            page.click('button[aria-label="Verify"]'),
        ]);

        // Token Extraction
        const userData = await page.evaluate(() => {
            const user = localStorage.getItem("user");
            return user ? JSON.parse(user) : null;
        });

        if (userData?.token) {
            log.info('✅ Login Successful! Extracting Token.');
            
            // Save to storage/datasets/default
            await Dataset.pushData({
                email,
                token: userData.token,
                timestamp: new Date().toISOString(),
            });

            // Save a local copy for your other modules to read
            fs.writeFileSync(
                path.join(__dirname, "nykaa-access-token.json"),
                JSON.stringify(userData, null, 2)
            );
        } else {
            throw new Error("Could not find user token in localStorage.");
        }
    },

    failedRequestHandler({ request, log }) {
        log.error(`Login failed for ${request.userData.email}. Check debug screenshots.`);
    },
});

// --- 3. Execution ---

async function main() {
    try {
        log.info("Authorizing Gmail...");
        globalAuthClient = await authorize();

        await crawler.run([
            {
                url: "https://seller.nykaa.com/login",
                userData: { 
                    email: "platforms@moxiebeauty.in",
                }
            }
        ]);
        
        log.info("Crawl complete.");
    } catch (error) {
        log.error(`Main Execution Error: ${error.message}`);
        process.exit(1);
    }
}

main();