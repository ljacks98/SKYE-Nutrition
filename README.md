# TrueMatch

A care navigator for dialysis clinics. Staff sign in, add patients, and log each treatment. The API works out how much fluid was removed and flags readings worth a second look: high blood pressure before treatment, low blood pressure after, or finishing more than 1 kg above dry weight.

This is a demo. Use made-up patients only (see [Before you store real patient data](#before-you-store-real-patient-data)).

## How it fits together

```
Browser (React app, hosted on AWS Amplify)
   │  1. Staff sign in ──────────▶ Amazon Cognito (admin-created accounts, MFA required)
   │  2. Every request carries the sign-in token
   ▼
API Gateway (HTTP API) ── refuses any request without a valid token
   ▼
Lambda: backend/src/app.mjs ── 4 routes, input checks, alerts, audit log
   ▼
DynamoDB ── Patients and Sessions tables (encrypted, point-in-time backups)
```

| File | What it does |
|---|---|
| `frontend/src/App.jsx` | The clinic screen: patient list, session form, treatment history |
| `frontend/src/main.jsx` | Connects to Cognito and shows the sign-in screen |
| `frontend/src/styles.css` | All styling: colors and fonts are the variables at the top |
| `frontend/src/api.js` | Calls the API with the signed-in user's token |
| `frontend/index.html` | Page title and icon |
| `backend/template.yaml` | Every AWS resource, in one file (AWS SAM) |
| `backend/src/app.mjs` | The API: list and add patients, list and add treatment sessions |
| `amplify.yml` | How Amplify builds and publishes the website |

## Changing the website

Amplify is connected to this repo's `main` branch. Commit a change to anything in `frontend/` and Amplify rebuilds and publishes the site in about 3 minutes. Watch progress in the AWS console under Amplify → TrueMatch → main.

To try changes on your computer first:

```bash
cd frontend
cp .env.example .env      # then paste in ApiUrl, UserPoolId and UserPoolClientId from the backend stack's Outputs
npm install
npm run dev               # then open http://localhost:5173
```

The website's three `VITE_` values are also saved as environment variables on the Amplify app, so the hosted site doesn't need a `.env` file.

## Changing the backend

Backend changes don't deploy on commit. From the `backend` folder (AWS CloudShell works well, since it has the SAM CLI built in):

```bash
sam deploy --stack-name truematch-backend --resolve-s3 --capabilities CAPABILITY_IAM
```

### Add a staff login

```bash
aws cognito-idp admin-create-user --user-pool-id YOUR_USER_POOL_ID --username person@example.com --user-attributes Name=email,Value=person@example.com Name=email_verified,Value=true --desired-delivery-mediums EMAIL
```

Cognito emails a temporary password. At first sign-in the person chooses a new password and scans a QR code with an authenticator app such as Google Authenticator or Authy.

### Lock the API to the website's address

While testing, the API accepts calls from any site (`SiteUrl=*`). Once the site has its final address, allow only that address:

```bash
sam deploy --stack-name truematch-backend --resolve-s3 --capabilities CAPABILITY_IAM --parameter-overrides SiteUrl=https://YOUR-SITE-ADDRESS
```

## Before you store real patient data

The defaults here are deliberately cautious: only an admin can create accounts, every user needs MFA, both tables are encrypted with point-in-time backups, the Lambda function can read and add records but never delete them, and the audit log records who did what without any medical details.

A system holding real patient records (PHI) still needs more. Accept AWS's Business Associate Addendum (BAA) in AWS Artifact and use only HIPAA-eligible AWS services. Add roles, for example Cognito groups that separate nurses from admins. Turn on a CloudTrail trail and set how long logs are kept. Have the clinical team set the alert limits at the top of `backend/src/app.mjs`. Finally, complete a security review and a HIPAA risk assessment. Until then, use made-up test patients.

## Clean up

Run `sam delete --stack-name truematch-backend` in the `backend` folder to remove the AWS resources and their data, then delete the TrueMatch app in the Amplify console.
