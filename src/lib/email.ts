import { createTransport } from "nodemailer";

const transporter =
  process.env.SMTP_HOST
    ? createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT ?? "587", 10),
        secure: process.env.SMTP_PORT === "465",
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      })
    : null;

const fromAddress = process.env.SMTP_FROM ?? "noreply@underlay.org";

interface EmailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendEmail(options: EmailOptions): Promise<boolean> {
  if (!transporter) {
    // SMTP not configured — log and skip
    console.log(`[email] Would send to ${options.to}: ${options.subject}`);
    return false;
  }

  try {
    await transporter.sendMail({
      from: fromAddress,
      to: options.to,
      subject: options.subject,
      text: options.text,
      html: options.html,
    });
    return true;
  } catch (err) {
    console.error("[email] Failed to send:", err);
    return false;
  }
}
