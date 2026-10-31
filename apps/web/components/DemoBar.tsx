// Demo and test money must never look real, so every money screen has to say which it is.
export function DemoBar() {
  return <div className="demo-bar" role="note"><b>Demo mode.</b> No real money moves.</div>;
}

export function TestBar() {
  return <div className="demo-bar" role="note"><b>Test mode.</b> Stripe test payments only. No real money moves.</div>;
}

// Live money gets no bar: only the worker's real figures.
export function MoneyBar({ stage, testMode }: { stage?: string; testMode?: boolean }) {
  if (stage === undefined || stage === "demo") return <DemoBar />;
  return testMode ? <TestBar /> : null;
}
