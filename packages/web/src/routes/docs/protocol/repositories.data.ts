import { redirect } from 'react-router'

// This page was at /docs/protocol/repositories before the pages were kept one folder a version; it
// described version 3.
export function loader() {
  return redirect('/docs/protocol/v3/repositories', 301)
}
