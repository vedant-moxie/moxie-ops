# Gmail API Setup Guide

This guide will help you set up Gmail API to automatically fetch OTP from your Gmail account.

## Prerequisites

1. A Google Cloud account
2. Access to the Gmail account where OTPs are received

## Setup Steps

### 1. Install Required Dependencies

```bash
pnpm add googleapis
```

### 2. Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable the Gmail API:
   - Go to "APIs & Services" > "Library"
   - Search for "Gmail API"
   - Click "Enable"

### 3. Create OAuth 2.0 Credentials

1. Go to "APIs & Services" > "Credentials"
2. Click "Create Credentials" > "OAuth client ID"
3. If prompted, configure the OAuth consent screen:
   - Choose "External" user type
   - Fill in the required app information
   - Add your email as a test user
   - Add the scope: `https://www.googleapis.com/auth/gmail.readonly`
4. For Application type, choose "Desktop app"
5. Give it a name (e.g., "Nykaa OTP Fetcher")
6. Click "Create"
7. Download the JSON file
8. Rename it to `gmail-credentials.json` and place it in the project root

### 4. First Run Authorization

When you run the script for the first time:

```bash
node login-otp-gmail.js
```

1. The script will display an authorization URL
2. Open the URL in your browser
3. Sign in with your Google account
4. Grant the requested permissions
5. Copy the authorization code from the browser
6. Paste it into the terminal
7. The token will be saved as `gmail-token.json` for future use

### 5. Customize Search Query (Optional)

In `login-otp-gmail.js`, you can customize the Gmail search query to match your OTP emails:

```javascript
const otp = await waitForOTP(
    auth,
    "from:noreply@nykka.com OTP OR subject:Verification Code", // Customize this
    120000, // timeout in ms
    5000 // poll interval in ms
);
```

Common search query examples:
- `"from:noreply@nykaa.com OTP"`
- `"subject:verification code"`
- `"OTP newer_than:1m"` (only emails from last minute)

## File Structure

After setup, your project will have:

```
├── login-otp-gmail.js         # Main script with Gmail integration
├── gmail-credentials.json     # OAuth credentials (do not commit!)
├── gmail-token.json          # Access token (do not commit!)
└── GMAIL_SETUP.md            # This guide
```

## Security Notes

⚠️ **Important**: Add these files to your `.gitignore`:

```
gmail-credentials.json
gmail-token.json
```

These files contain sensitive authentication information and should never be committed to version control.

## Troubleshooting

### "No messages found matching the query"
- Check if the email sender/subject matches your search query
- Try a broader search query
- Verify the OTP email was actually received in Gmail

### "Error fetching emails: invalid_grant"
- Delete `gmail-token.json` and run the script again to re-authorize

### "Please download OAuth2 credentials"
- Make sure `gmail-credentials.json` exists in the project root
- Verify the JSON format is correct

### OTP not detected
- The script looks for 6 digit numbers in emails
- Check if your OTP format is different and modify the `extractOTP` function accordingly

## How It Works

1. **Authorization**: Uses OAuth 2.0 to access your Gmail account (read-only)
2. **Email Search**: Searches for recent emails matching the criteria
3. **OTP Extraction**: Uses regex patterns to extract numeric OTPs
4. **Polling**: Checks for new emails every 5 seconds until OTP is found
5. **Auto-fill**: Automatically enters the OTP in the Nykaa login form

## Usage

Once configured, simply run:

```bash
node login-otp-gmail.js
```

The script will:
1. Open the Nykaa login page
2. Fill in the email
3. Request OTP
4. Automatically fetch the OTP from Gmail
5. Enter and verify the OTP
6. Extract and display the access token
