const nodemailer = require("nodemailer");

const APP_NAME = "WatchMyWallet";



function createTransport() {
  console.log(process.env.SMTP_USER, process.env.SMTP_PASS, "--------------------------")
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST   || "smtp.gmail.com",
    port:   parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

const COPY = {
  signup: {
    heading: `Confirm your email`,
    intro:   `Enter this code in the app to finish creating your ${APP_NAME} account.`,
  },
  reset: {
    heading: `Reset your password`,
    intro:   `Enter this code in the app to choose a new password.`,
  },
};

// Six digits by mail, no link. Deep links only survive if the app is installed and the mail
// client honours the scheme; a code the user can read off the screen works from any inbox on any
// device, which is the whole reason this replaced the link flow.
exports.sendOtpEmail = async (to, code, purpose, ttlMinutes) => {
  const copy = COPY[purpose] || COPY.signup;
  const transport = createTransport();
  await transport.sendMail({
    from:    `"${APP_NAME}" <${process.env.SMTP_USER}>`,
    to,
    // The code is in the subject as well: most clients show it in the notification, so the
    // common case never needs the mail opened at all.
    subject: `Your ${APP_NAME} code: ${code}`,
    // A text alternative, because a code rendered only in HTML is unreadable to anyone whose
    // client blocks it — and that is the one thing this mail exists to deliver.
    text: `${copy.intro}\n\n${code}\n\nThe code expires in ${ttlMinutes} minutes. If you didn't ask for it, ignore this email.`,
    html: `
      <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
        <h2 style="margin:0 0 8px;font-size:20px;color:#111">${copy.heading}</h2>
        <p style="margin:0 0 24px;font-size:15px;color:#444">${copy.intro}</p>
        <div style="font-size:32px;font-weight:700;letter-spacing:.22em;text-align:center;padding:20px;background:#F4F4F7;border-radius:12px;color:#111">${code}</div>
        <p style="margin:24px 0 0;font-size:13px;color:#666">This code expires in ${ttlMinutes} minutes.</p>
        <p style="margin:8px 0 0;font-size:12px;color:#999">If you didn't request it, you can safely ignore this email.</p>
      </div>
    `,
  });
};
