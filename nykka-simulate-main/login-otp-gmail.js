import puppeteer from "puppeteer";
import { addExtra } from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { google } from "googleapis";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];
const TOKEN_PATH = path.join(__dirname, "gmail-token.json");
const CREDENTIALS_PATH = path.join(__dirname, "gmail-credentials.json");


const pE = addExtra(puppeteer);
pE.use(StealthPlugin());

async function authorize() {
  let credentials;
  try {
    credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
  } catch (err) {
    throw new Error(
      "Please download OAuth2 credentials from Google Cloud Console and save as gmail-credentials.json"
    );
  }

  const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);


  try {
    const token = fs.readFileSync(TOKEN_PATH, "utf8");
    oAuth2Client.setCredentials(JSON.parse(token));
    return oAuth2Client;
  } catch (err) {
    return getNewToken(oAuth2Client);
  }
}

/**
 * Get and store new token after prompting for user authorization
 */
async function getNewToken(oAuth2Client) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
  });
  console.log("\n Authorize this app by visiting this url:\n", authUrl);
  
  const readline = await import("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve, reject) => {
    rl.question("\n  Enter the code from that page here: ", (code) => {
      rl.close();
      oAuth2Client.getToken(code, (err, token) => {
        if (err) {
          reject(err);
          return;
        }
        oAuth2Client.setCredentials(token);
        // Store the token to disk for later program executions
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
        console.log(" Token stored to", TOKEN_PATH);
        resolve(oAuth2Client);
      });
    });
  });
}

/**
 * Extract OTP from email body
 */
function extractOTP(emailBody) {
  const patterns = [
    /\b(\d{6})\b/g, // 6-digit OTP
    /OTP[:\s]+(\d+)/gi,
    /code[:\s]+(\d+)/gi,
    /verification code[:\s]+(\d+)/gi,
  ];

  for (const pattern of patterns) {
    const matches = emailBody.match(pattern);
    if (matches && matches.length > 0) {
      const otp = matches[0].replace(/\D/g, "");
      if (otp.length >= 4 && otp.length <= 6) {
        return otp;
      }
    }
  }
  return null;
}


async function fetchOTPFromGmail(auth, searchQuery = "from:noreply@nykaa.com", maxResults = 1) {
  const gmail = google.gmail({ version: "v1", auth });

  try {
    // Search for recent emails matching the query (within last 1 minute)
    const searchQueryWithTime = `${searchQuery} newer_than:1m`;
    const res = await gmail.users.messages.list({
      userId: "me",
      q: searchQueryWithTime,
      maxResults: maxResults,
    });

    const messages = res.data.messages;
    if (!messages || messages.length === 0) {
      console.log("❌ No messages found matching the query in the last 1 minute.");
      return null;
    }

    console.log(`📧 Found ${messages.length} message(s) in the last 1 minute. Checking for OTP...`);


    for (const message of messages) {
      const msg = await gmail.users.messages.get({
        userId: "me",
        id: message.id,
        format: "full",
      });

      // If this is part of a thread, get the latest message in the thread
      let targetMsg = msg;
      if (msg.data.threadId && msg.data.threadId !== msg.data.id) {
        // Get all messages in the thread
        const threadRes = await gmail.users.threads.get({
          userId: "me",
          id: msg.data.threadId,
          format: "full",
        });
        
        // Get the last message in the thread (most recent)
        if (threadRes.data.messages && threadRes.data.messages.length > 0) {
          const latestMessage = threadRes.data.messages[threadRes.data.messages.length - 1];
          targetMsg = { data: latestMessage };
        }
      }

      // Get email body from the target message
      // Walk payload recursively to collect text/plain and text/html parts (some emails are HTML-only)
      function getBodyFromPayload(payload) {
        let bodyText = "";

        if (!payload) return bodyText;

        if (payload.body && payload.body.data) {
          try {
            bodyText += Buffer.from(payload.body.data, "base64").toString("utf-8");
          } catch (e) {
            // ignore decode errors
          }
        }

        if (payload.parts && Array.isArray(payload.parts)) {
          for (const part of payload.parts) {
            bodyText += getBodyFromPayload(part);
          }
        }

        return bodyText;
      }

      const emailBody = getBodyFromPayload(targetMsg.data.payload) || "";

      // Get email subject
      const subject = targetMsg.data.payload.headers.find((h) => h.name === "Subject")?.value || "";
      console.log(`Subject: ${subject}`);

      // Try to extract OTP
      const otp = extractOTP(emailBody + " " + subject);
      if (otp) {
        console.log(`Found OTP: ${otp}`);
        return otp;
      }
    }

    console.log("No OTP found in recent emails.");
    return null;
  } catch (error) {
    console.error("Error fetching emails:", error.message);
    return null;
  }
}

/**
 * Wait for new OTP email with polling
 */
async function waitForOTP(auth, searchQuery = "from:nykaa OTP", timeoutMs = 120000, pollIntervalMs = 5000) {
  const startTime = Date.now();
  console.log("Waiting 15 seconds before checking for OTP to ensure email delivery...");
  await new Promise((resolve) => setTimeout(resolve, 15000));
  console.log("Starting OTP polling...");

  while (Date.now() - startTime < timeoutMs) {
    const otp = await fetchOTPFromGmail(auth, searchQuery, 3);
    if (otp) {
      return otp;
    }
    console.log(`No OTP yet, checking again in ${pollIntervalMs / 1000}s...`);
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error("Timeout waiting for OTP email");
}

/**
 * Main login function - can be exported for use in other modules
 */
async function loginAndGetToken(email = "platforms@moxiebeauty.in") {
  console.log("Starting Nykaa login with Gmail OTP...\n");

  // Authorize Gmail API
  console.log("Authorizing Gmail API...");
  const auth = await authorize();
  console.log("Gmail API authorized\n");

  // Launch browser
  const browser = await pE.launch({
    headless: process.env.CI === 'true' ? true : false, // headless in CI, GUI locally
    args: [
      "--disable-http2",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage", // Overcome limited resource problems in CI
      "--disable-gpu", // Applicable to windows os only
    ],
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );
  
  await page.goto("https://seller.nykaa.com/login", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  // Fill email
  console.log("Filling email...");
  await page.waitForSelector('input[name="email"]', { visible: true, timeout: 30000 });
  await page.type('input[name="email"]', email, { delay: 100 });

  // Click "Login" button
  console.log("Clicking login button...");
  await page.click('button[aria-label="Login to Nykaa"]');
  
  // Wait for OTP inputs to appear (with longer timeout)
  console.log("Waiting for OTP input fields...");
  try {
    await page.waitForSelector('.input-component__input.no-label-input', { 
      visible: true, 
      timeout: 30000 
    });
  } catch (error) {
    // Take a screenshot to debug
    await page.screenshot({ path: "debug_login_error.png", fullPage: true });
    console.error("Failed to find OTP input fields. Screenshot saved to debug_login_error.png");
    throw error;
  }

  // Wait for OTP from Gmail
  console.log("\n Fetching OTP from Gmail...");
  const otp = await waitForOTP(
    auth,
    "from:noreply@nykaa.com subject:Verification Code to Login into your Nykaa account", // Customized for Nykaa OTP emails
    120000, // 2 minutes timeout
    5000 // Check every 5 seconds
  );

  if (!otp) {
    console.log("Could not retrieve OTP from Gmail");
    await browser.close();
    throw new Error("Failed to retrieve OTP from Gmail");
  }

  console.log(`\n Retrieved OTP: ${otp}`);
  console.log("⌨️  Entering OTP...");

  // Enter OTP
  const otpInputs = await page.$$('.input-component__input.no-label-input');
  for (let i = 0; i < otp.length && i < otpInputs.length; i++) {
    await otpInputs[i].type(otp[i]);
  }

  // Verify OTP
  console.log("Verifying OTP...");
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }),
    page.click('button[aria-label="Verify"]'),
  ]);

  // Extract token and user data
  const userData = await page.evaluate(() => {
    const userString = localStorage.getItem("user");
    if (userString) {
      return JSON.parse(userString);
    } else {
      return null;
    }
  });

  if (userData && userData.token) {
    console.log("\n Login successful!");
    console.log(" Access Token:", userData.token);
    
    // Save token and domain to file for persistence
    const tokenData = {
      token: userData.token,
      domain: "Beauty",
      email: email,
      timestamp: new Date().toISOString(),
      expiresAt: userData.expiresAt || null
    };
    
    const tokenFilePath = path.join(__dirname, "nykaa-access-token.json");
    fs.writeFileSync(tokenFilePath, JSON.stringify(tokenData, null, 2));
    console.log(" Token saved to:", tokenFilePath);
  } else {
    console.log("\n  No user found in localStorage");
    await browser.close();
    throw new Error("Failed to extract access token");
  }

  await page.screenshot({ path: "after_verify.png", fullPage: true });
  console.log("Screenshot saved as after_verify.png");

  await browser.close();
  console.log("\nDone!");
  
  return userData;
}

/**
 * Load saved token from file
 */
function loadSavedToken() {
  const tokenFilePath = path.join(__dirname, "nykaa-access-token.json");
  try {
    const data = fs.readFileSync(tokenFilePath, "utf8");
    return JSON.parse(data);
  } catch (error) {
    return null;
  }
}

// Main function for standalone execution
async function main() {
  try {
    await loginAndGetToken();
  } catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
  }
}

// Export functions for use in other modules
export { loginAndGetToken, loadSavedToken };

// Run the script if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
