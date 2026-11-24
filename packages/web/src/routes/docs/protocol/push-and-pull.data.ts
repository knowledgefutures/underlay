import { redirect } from 'react-router'

// This page was at /docs/protocol/push-and-pull before the pages were kept one folder a version; it
// described version 3.
export function loader() {
  return redirect('/docs/protocol/v3/push-and-pull', 301)
}
