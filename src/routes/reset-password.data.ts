import { redirect } from 'react-router'

// Password management now happens via KF Auth — always redirect to /login.
export function loader() {
  return redirect('/login')
}
