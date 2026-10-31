import { useEffect, useState } from "react";

const midnight = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

// The start of today on this device, updating when the day rolls over.
export function useDayStart(): number {
  const [dayStart, setDayStart] = useState(midnight);
  useEffect(() => {
    const id = setInterval(() => setDayStart(midnight()), 60_000);
    return () => clearInterval(id);
  }, []);
  return dayStart;
}
