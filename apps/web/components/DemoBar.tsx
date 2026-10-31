// Payments are simulated until Stripe is connected, and every money screen has to say so.
export function DemoBar() {
  return <div className="demo-bar" role="note"><b>Demo mode.</b> No real money moves.</div>;
}
