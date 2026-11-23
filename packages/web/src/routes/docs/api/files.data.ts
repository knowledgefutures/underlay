import { redirect } from 'react-router'

// The Files API page is now the Assets API page; /docs/api/files stays as a link to it.
export function loader() {
  return redirect('/docs/api/assets', 301)
}
