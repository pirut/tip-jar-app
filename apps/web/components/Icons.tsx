type Props = { size?: number };

function Svg({ size = 20, children }: Props & { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

export const IconTips = (p: Props) => <Svg {...p}><rect x="3" y="6" width="18" height="13" rx="2.5" /><path d="M3 10.5h18M16 15h2" /></Svg>;
export const IconCrew = (p: Props) => <Svg {...p}><circle cx="9" cy="8" r="3.25" /><path d="M2.75 19.5c0-3.3 2.8-5.5 6.25-5.5s6.25 2.2 6.25 5.5M16 5a3.25 3.25 0 0 1 0 6.3M18 14.4c2 .7 3.25 2.5 3.25 5.1" /></Svg>;
export const IconEarnings = (p: Props) => <Svg {...p}><path d="M5 20v-6M12 20V9M19 20V4" /></Svg>;
export const IconCheck = (p: Props) => <Svg {...p}><path d="m5 12.5 4.5 4.5L19 7.5" /></Svg>;
export const IconCopy = (p: Props) => <Svg {...p}><rect x="9" y="9" width="11" height="11" rx="2.5" /><path d="M15 9V6.5A2.5 2.5 0 0 0 12.5 4h-6A2.5 2.5 0 0 0 4 6.5v6A2.5 2.5 0 0 0 6.5 15H9" /></Svg>;
export const IconShare = (p: Props) => <Svg {...p}><path d="M12 15V4M8 7.5 12 3.5l4 4M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" /></Svg>;
export const IconPrint = (p: Props) => <Svg {...p}><path d="M7 8V3.5h10V8M7 17H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><rect x="7" y="14" width="10" height="6.5" rx="1" /></Svg>;
export const IconBackspace = (p: Props) => <Svg {...p}><path d="M9 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6-7 6-7ZM12.5 9.5l5 5M17.5 9.5l-5 5" /></Svg>;
export const IconArrow = (p: Props) => <Svg {...p}><path d="M5 12h14M13 6l6 6-6 6" /></Svg>;
