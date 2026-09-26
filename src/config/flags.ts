/**
 * Feature flags — mamoru.lol teaser.
 * PUBLIC_SHOW_EMAIL_FORM defaults off (unset ≠ "true").
 * Flip only after segundo Ot GO for live form deploy.
 */
export const SHOW_EMAIL_FORM =
  import.meta.env.PUBLIC_SHOW_EMAIL_FORM === "true";
