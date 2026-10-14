import "react";

// Firefox restores a <button>'s dynamic `disabled` state across reloads before React hydrates, so a button that renders
// disabled on the server and enabled after hydration (or the reverse) triggers an attribute mismatch. `autocomplete="off"`
// turns that restoration off; React renders the prop, but its types only declare it for form fields.
declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- must match React's declaration to merge
  interface ButtonHTMLAttributes<T> {
    autoComplete?: "off";
  }
}
