import { redirect } from 'react-router'

// Account creation now happens via KF Auth — always redirect to /login.
export function loader() {
  return redirect('/login')
}
