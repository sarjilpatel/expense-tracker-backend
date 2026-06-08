const nodemailer = require("nodemailer");

function createTransport() {
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

exports.sendPasswordResetEmail = async (to, token) => {
  const appName   = "Expense Tracker";
  const resetLink = `${process.env.APP_DEEP_LINK || "expensetrackerapp://"}reset-password/${token}`;
  const transport = createTransport();
  await transport.sendMail({
    from:    `"${appName}" <${process.env.SMTP_USER}>`,
    to,
    subject: "Reset your password",
    html: `
      <h2>${appName} — Password Reset</h2>
      <p>We received a request to reset your password. Click the button below within <strong>1 hour</strong>.</p>
      <a href="${resetLink}" style="display:inline-block;padding:12px 28px;background:#5856D6;color:#fff;border-radius:8px;text-decoration:none;font-weight:700">Reset Password</a>
      <p style="color:#666;font-size:12px;margin-top:24px">If you didn't request this, you can safely ignore this email.</p>
    `,
  });
};

exports.sendVerificationEmail = async (to, token) => {
  const appName      = "Expense Tracker";
  const verifyLink   = `${process.env.APP_DEEP_LINK || "expensetrackerapp://"}verify-email/${token}`;
  const transport = createTransport();
  await transport.sendMail({
    from:    `"${appName}" <${process.env.SMTP_USER}>`,
    to,
    subject: "Verify your email address",
    html: `
      <h2>Welcome to ${appName}!</h2>
      <p>Please verify your email address to complete your registration.</p>
      <a href="${verifyLink}" style="display:inline-block;padding:12px 28px;background:#34C759;color:#fff;border-radius:8px;text-decoration:none;font-weight:700">Verify Email</a>
      <p style="color:#666;font-size:12px;margin-top:24px">This link expires in 24 hours.</p>
    `,
  });
};
