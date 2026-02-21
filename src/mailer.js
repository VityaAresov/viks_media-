const nodemailer = require("nodemailer");

let transporter = null;

function getTransporter() {
  if (transporter) {
    return transporter;
  }

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (host && user && pass) {
    transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass }
    });
    return transporter;
  }

  transporter = nodemailer.createTransport({
    jsonTransport: true
  });
  return transporter;
}

async function sendMail({ to, subject, html, text }) {
  const from = process.env.SMTP_FROM || "no-reply@viks-media.local";
  const info = await getTransporter().sendMail({
    from,
    to,
    subject,
    html,
    text
  });

  if (info && info.message) {
    // eslint-disable-next-line no-console
    console.log("Mail preview:", info.message.toString());
  }
}

module.exports = {
  sendMail
};
