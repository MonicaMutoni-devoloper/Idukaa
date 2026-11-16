/**
 * The two messages this API sends. Kept as plain functions so they can be printed by a test and
 * reviewed by a person: no template engine, no remote assets (an image that fails to load is a
 * broken message), and every interpolated value escaped.
 *
 * The text part is not a courtesy — it is what a phone's lock-screen preview and a suspicious Gmail
 * client actually render, and it must contain the link on its own line so it stays clickable.
 */

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const firstName = (fullName: string) => fullName.trim().split(/\s+/)[0] || "there";

function layout(opts: { heading: string; intro: string; button: string; url: string; after: string; footer: string }) {
  const url = esc(opts.url);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.heading)}</title></head>
<body style="margin:0;padding:24px 12px;background:#f4f5f3;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1b1f1d">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e3e6e2;border-radius:12px">
    <tr><td style="padding:20px 24px;border-bottom:1px solid #eef0ec">
      <span style="font-size:18px;font-weight:700;letter-spacing:-.2px">Idukaa</span>
      <span style="font-size:12px;color:#6b736d;margin-left:8px">Shop records</span>
    </td></tr>
    <tr><td style="padding:24px">
      <h1 style="margin:0 0 12px;font-size:20px;line-height:1.3">${esc(opts.heading)}</h1>
      <p style="margin:0 0 20px;font-size:15px;line-height:1.55;color:#39413b">${esc(opts.intro)}</p>
      <p style="margin:0 0 8px">
        <a href="${url}" style="display:inline-block;background:#14532d;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 20px;border-radius:8px">${esc(opts.button)}</a>
      </p>
      <p style="margin:16px 0 0;font-size:13px;line-height:1.55;color:#6b736d">${esc(opts.after)}</p>
      <p style="margin:12px 0 0;font-size:12px;line-height:1.5;color:#8a918c;word-break:break-all">${url}</p>
    </td></tr>
    <tr><td style="padding:16px 24px;border-top:1px solid #eef0ec;font-size:12px;line-height:1.5;color:#8a918c">
      ${esc(opts.footer)}
    </td></tr>
  </table>
</body></html>`;
}

export function verificationEmail(o: { name: string; url: string; hours: number }) {
  const intro =
    `Hello ${firstName(o.name)}, confirm that this is your e-mail address and your Idukaa account ` +
    `will be allowed to sign in. The link works once and expires in ${o.hours} hours.`;
  const text = [
    `Hello ${firstName(o.name)},`,
    ``,
    `Confirm your e-mail address to finish setting up your Idukaa account:`,
    o.url,
    ``,
    `The link works once and expires in ${o.hours} hours. If it expires, ask for a new one from the`,
    `sign-in screen.`,
    ``,
    `If you did not create an account, ignore this message — nothing was activated.`,
    ``,
    `Idukaa`,
  ].join("\n");
  return {
    subject: "Confirm your e-mail address for Idukaa",
    text,
    html: layout({
      heading: "Confirm your e-mail address",
      intro,
      button: "Confirm this address",
      url: o.url,
      after: "If the button does not work, copy the address below into your browser. The link can be used once.",
      footer: "You received this because this address was used to register a shop on Idukaa. Ignore it if that was not you — no account was activated by this message.",
    }),
  };
}

export function passwordResetEmail(o: { name: string; url: string; minutes: number }) {
  const intro =
    `Hello ${firstName(o.name)}, use the button below to choose a new password. The link works once ` +
    `and expires in ${o.minutes} minutes.`;
  const text = [
    `Hello ${firstName(o.name)},`,
    ``,
    `Choose a new Idukaa password here:`,
    o.url,
    ``,
    `The link works once and expires in ${o.minutes} minutes.`,
    ``,
    `Signing in on other devices will end. If you did not ask for this, your password is still the`,
    `old one — tell whoever administers your shop.`,
    ``,
    `Idukaa`,
  ].join("\n");
  return {
    subject: "Choose a new Idukaa password",
    text,
    html: layout({
      heading: "Choose a new password",
      intro,
      button: "Choose a new password",
      url: o.url,
      after: "If you did not ask for this, ignore the message: your password has not changed.",
      footer: "Password resets end every signed-in session for this account.",
    }),
  };
}
