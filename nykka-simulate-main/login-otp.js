import { google } from "googleapis";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";

config({ override: false });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];
const TOKEN_PATH = path.join(__dirname, "gmail-token.json");
const CREDENTIALS_PATH = path.join(__dirname, "gmail-credentials.json");

const TWOCAPTCHA_KEY = process.env.TWOCAPTCHA_API_KEY;
if (!TWOCAPTCHA_KEY) throw new Error("TWOCAPTCHA_API_KEY not set in .env");

// Sitekey extracted from the real browser network request
const NYKAA_SITEKEY = "6LezEMUUAAAAAD5e03qpKu8apgqrINORZnxu8x_N";
const NYKAA_PAGE    = "https://seller.nykaa.com/login";
const NYKAA_API     = "https://spbackend.nyk00-int.network/seller-portal/api/v1/auth";

const HEADERS = {
  "accept":                    "application/json, text/plain, */*",
  "accept-language":           "en-GB,en-US;q=0.9,en;q=0.8",
  "content-type":              "application/json",
  "origin":                    "https://seller.nykaa.com",
  "referer":                   "https://seller.nykaa.com/",
  "sec-ch-ua":                 '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
  "sec-ch-ua-mobile":          "?0",
  "sec-ch-ua-platform":        '"macOS"',
  "sec-fetch-dest":            "empty",
  "sec-fetch-mode":            "cors",
  "sec-fetch-site":            "cross-site",
  "sec-fetch-storage-access":  "active",
  "user-agent":                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
};

// ── 2captcha: submit once, poll until ready ──────────────────────────────────
async function solveCaptcha(label = "") {
  console.log(`  [2captcha${label}] Submitting...`);

  const sub = await fetch(
    `https://2captcha.com/in.php?key=${TWOCAPTCHA_KEY}&method=userrecaptcha&invisible=1` +
    `&googlekey=${NYKAA_SITEKEY}&pageurl=${encodeURIComponent(NYKAA_PAGE)}&json=1`
  ).then(r => r.json());

  if (sub.status !== 1) throw new Error(`2captcha submit failed: ${sub.request}`);

  const id = sub.request;
  console.log(`  [2captcha${label}] Queued (ID: ${id}) — polling...`);

  await new Promise(r => setTimeout(r, 15000));

  for (let i = 0; i < 21; i++) {
    const res = await fetch(
      `https://2captcha.com/res.php?key=${TWOCAPTCHA_KEY}&action=get&id=${id}&json=1`
    ).then(r => r.json());

    if (res.status === 1) {
      console.log(`  [2captcha${label}] Token received`);
      return res.request;
    }
    if (res.request !== "CAPCHA_NOT_READY") throw new Error(`2captcha error: ${res.request}`);
    console.log(`  [2captcha${label}] Still solving... (${15 + (i + 1) * 5}s)`);
    await new Promise(r => setTimeout(r, 5000));
  }

  throw new Error("2captcha timed out after 120s");
}

// ── Gmail OAuth ──────────────────────────────────────────────────────────────
async function authorize() {
  let credentials;
  try {
    credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
  } catch {
    throw new Error("Save OAuth2 credentials as gmail-credentials.json");
  }

  const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  try {
    oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8")));
    return oAuth2Client;
  } catch {
    return getNewToken(oAuth2Client);
  }
}

async function getNewToken(oAuth2Client) {
  const authUrl = oAuth2Client.generateAuthUrl({ access_type: "offline", scope: SCOPES });
  console.log("\n Authorize Gmail by visiting:\n", authUrl);

  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve, reject) => {
    rl.question("\n Enter the code: ", (code) => {
      rl.close();
      oAuth2Client.getToken(code, (err, token) => {
        if (err) return reject(err);
        oAuth2Client.setCredentials(token);
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
        resolve(oAuth2Client);
      });
    });
  });
}

function extractOTP(text) {
  const patterns = [/\b(\d{6})\b/g, /OTP[:\s]+(\d+)/gi, /code[:\s]+(\d+)/gi];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const digits = m[0].replace(/\D/g, "");
      if (digits.length >= 4 && digits.length <= 6) return digits;
    }
  }
  return null;
}

async function fetchOTPFromGmail(auth) {
  const gmail = google.gmail({ version: "v1", auth });
  const res = await gmail.users.messages.list({
    userId: "me",
    q: "from:noreply@nykaa.com subject:Verification Code to Login into your Nykaa account newer_than:2m",
    maxResults: 3,
  });

  if (!res.data.messages?.length) return null;

  for (const { id } of res.data.messages) {
    const msg = await gmail.users.messages.get({ userId: "me", id, format: "full" });

    const walk = (payload) => {
      let text = "";
      if (payload?.body?.data) {
        try { text += Buffer.from(payload.body.data, "base64").toString("utf-8"); } catch {}
      }
      for (const part of payload?.parts ?? []) text += walk(part);
      return text;
    };

    const body = walk(msg.data.payload);
    const subject = msg.data.payload.headers.find(h => h.name === "Subject")?.value ?? "";
    const otp = extractOTP(body + " " + subject);
    if (otp) { console.log(` Found OTP: ${otp}`); return otp; }
  }
  return null;
}

async function waitForOTP(auth, timeoutMs = 120000, pollMs = 5000) {
  console.log(" Waiting 15s for OTP email to arrive...");
  await new Promise(r => setTimeout(r, 15000));

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const otp = await fetchOTPFromGmail(auth);
    if (otp) return otp;
    console.log(` No OTP yet, retrying in ${pollMs / 1000}s...`);
    await new Promise(r => setTimeout(r, pollMs));
  }
  throw new Error("Timeout waiting for OTP email");
}

// ── Main login flow (no browser) ─────────────────────────────────────────────
async function loginAndGetToken(email = "platforms@moxiebeauty.in") {
  console.log(" Starting Nykaa login via API...\n");

  const auth = await authorize();
  console.log(" Gmail API authorized\n");

  // ── STEP 1: Solve CAPTCHA for signIn ────────────────────────────────────────
  console.log("[1/4] Solving CAPTCHA for sign-in...");
  const captchaToken1 = await solveCaptcha(" #1");

  // ── STEP 2: POST /auth/signIn → triggers OTP email ──────────────────────────
  console.log("[2/4] Calling signIn API...");
  const signInResp = await fetch(`${NYKAA_API}/signIn`, {
    method: "POST",
    headers: { ...HEADERS, "x-recaptcha-token": captchaToken1 },
    body: JSON.stringify({ email }),
  });
  const signInData = await signInResp.json();
  console.log("  signIn response:", JSON.stringify(signInData));

  if (!signInResp.ok) throw new Error(`signIn failed (${signInResp.status}): ${JSON.stringify(signInData)}`);

  // user_code may come from signIn response (server-side session identifier)
  const userCode = signInData?.user_code ?? signInData?.data?.user_code ?? signInData?.userCode ?? "undefined";

  // ── STEP 3+4 in parallel: fetch OTP while solving CAPTCHA #2 ────────────────
  console.log("[3/4] Fetching OTP from Gmail + solving CAPTCHA #2 in parallel...");
  const [otp, captchaToken2] = await Promise.all([
    waitForOTP(auth),
    solveCaptcha(" #2"),
  ]);
  if (!otp) throw new Error("Could not retrieve OTP from Gmail");
  console.log(`  OTP: ${otp}  |  CAPTCHA #2 ready`);

  // ── STEP 4: POST /auth/verifyTwoFaCode ───────────────────────────────────────
  console.log("[4/4] Verifying OTP...");
  const verifyResp = await fetch(`${NYKAA_API}/verifyTwoFaCode`, {
    method: "POST",
    headers: { ...HEADERS, "x-recaptcha-token": captchaToken2 },
    body: JSON.stringify({ two_fa_code: otp, user_code: userCode, email }),
  });
  const verifyData = await verifyResp.json();
  console.log("  verifyTwoFaCode response:", JSON.stringify(verifyData));

  if (!verifyResp.ok) throw new Error(`verifyTwoFaCode failed (${verifyResp.status}): ${JSON.stringify(verifyData)}`);

  const token =
    verifyData?.data?.access_token ??
    verifyData?.data?.token ??
    verifyData?.token ??
    verifyData?.data?.accessToken ??
    verifyData?.accessToken;

  if (!token) throw new Error(`No token in response: ${JSON.stringify(verifyData)}`);

  console.log("\n Login successful!");
  const tokenData = {
    token,
    refresh_token: verifyData?.data?.refresh_token ?? null,
    domain: "Beauty",
    email,
    timestamp: new Date().toISOString(),
    expiresAt: verifyData?.expiresAt ?? verifyData?.data?.expiresAt ?? null,
  };

  const tokenFilePath = path.join(__dirname, "nykaa-access-token.json");
  fs.writeFileSync(tokenFilePath, JSON.stringify(tokenData, null, 2));
  console.log(` Token saved to: ${tokenFilePath}`);

  return tokenData;
}

function loadSavedToken() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "nykaa-access-token.json"), "utf8"));
  } catch {
    return null;
  }
}

async function main() {
  try {
    await loginAndGetToken();
  } catch (error) {
    console.error(" Error:", error.message);
    process.exit(1);
  }
}

export { loginAndGetToken, loadSavedToken };

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
