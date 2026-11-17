import { redirect } from 'react-router'

// The CLI's docs are at /docs/cli; /cli stays as a short link to them. The CLI itself is
// served below it (/cli/install.sh, /cli/underlay.js).
export function loader() {
  return redirect('/docs/cli', 301)
}
