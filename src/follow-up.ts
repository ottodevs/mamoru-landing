/**
 * The one note we send after someone leaves an email.
 * Copy closed by Brais, plus the custody line Ot asked for.
 * One note. No list rental, no second automated send.
 *
 * Outbound path: Loops Free transactional (not CF Email Sending).
 * Keep this file as the source of truth for the Loops template body.
 */

export const FOLLOW_UP_SUBJECT = "Welcome to Mamoru";

export const FOLLOW_UP_LINES = [
  "Welcome to Mamoru.",
  "Thanks for your interest. You're on the list.",
  "We'll write when mamoru.lol gets ready.",
  "Your email stays with us.",
] as const;

export const CUSTODY_LINE =
  "We keep it the way we keep funds, and we will not send you anything else.";

export const MAIL_FROM = {
  email: "notify@mamoru.lol",
  name: "Mamoru",
} as const;

const RICE = "#F8F5EF";
const INK = "#0F0F0E";
const STONE = "#8A8578";

export const FOLLOW_UP_TEXT = [
  FOLLOW_UP_LINES[0],
  "",
  FOLLOW_UP_LINES[1],
  "",
  FOLLOW_UP_LINES[2],
  "",
  FOLLOW_UP_LINES[3],
  CUSTODY_LINE,
  "",
  "Mamoru",
  "https://mamoru.lol",
].join("\n");

export function followUpHtml(withMark: boolean): string {
  const mark = withMark
    ? `<img src="cid:mamoru-mark" width="56" height="56" alt="Mamoru" style="display:block;border:0;width:56px;height:56px;" />`
    : "";
  const lines = FOLLOW_UP_LINES.map(
    (line) =>
      `<tr><td style="font-family:'Noto Serif',Georgia,'Times New Roman',serif;font-size:17px;line-height:1.45;color:${INK};padding:0 0 18px;">${line}</td></tr>`,
  ).join("");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${FOLLOW_UP_SUBJECT}</title>
</head>
<body style="margin:0;padding:0;background:${RICE};">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${FOLLOW_UP_LINES[3]} ${CUSTODY_LINE}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${RICE};">
    <tr>
      <td align="left" style="padding:48px 32px 64px;">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
          <tr>
            <td style="padding:0 0 28px;">
              ${mark}
              <div style="font-family:'Noto Serif',Georgia,'Times New Roman',serif;font-size:15px;line-height:1.2;color:${INK};padding-top:10px;">Mamoru</div>
            </td>
          </tr>
          ${lines}
          <tr>
            <td style="font-family:'Noto Serif',Georgia,'Times New Roman',serif;font-size:16px;line-height:1.45;color:${STONE};padding:6px 0 0;">${CUSTODY_LINE}</td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
