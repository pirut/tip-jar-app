export default function Loading() {
  return (
    <main className="guest" aria-busy="true" aria-label="Loading">
      <div className="skel" style={{ width: 96, height: 24, marginTop: 34 }} />
      <div className="skel" style={{ width: "60%", height: 32 }} />
      <div className="skel" style={{ height: 56 }} />
      <div className="skel" style={{ height: 120 }} />
      <div className="skel" style={{ height: 52, marginTop: "auto" }} />
    </main>
  );
}
