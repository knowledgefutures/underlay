import { redirect } from 'react-router'

import { CURRENT_PROTOCOL } from '~/lib/protocol'

// /docs/protocol leads to the current version's pages, wherever they are.
export function loader() {
  return redirect(`/docs/protocol/v${CURRENT_PROTOCOL}`, 302)
}
