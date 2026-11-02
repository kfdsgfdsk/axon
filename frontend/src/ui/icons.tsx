/* One-file SVG icon set — stroke 1.7, 24 viewBox, currentColor. */

import React from 'react';

function I({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

export const IconOverview = () => <I><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></I>;
export const IconMarkets = () => <I><path d="M3 17l5-6 4 3 6-8" /><path d="M18 6h-4M18 6v4" /><path d="M3 21h18" /></I>;
export const IconTrade = () => <I><path d="M7 4v13M7 17l-3-3M7 17l3-3" /><path d="M17 20V7M17 7l-3 3M17 7l3 3" /></I>;
export const IconDeposit = () => <I><path d="M12 3v12M12 15l-4-4M12 15l4-4" /><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" /></I>;
export const IconWithdraw = () => <I><path d="M12 15V3M12 3L8 7M12 3l4 4" /><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" /></I>;
export const IconAgent = () => <I><circle cx="8" cy="12" r="2.4" /><circle cx="17" cy="6" r="1.8" /><circle cx="17" cy="18" r="1.8" /><path d="M10.2 10.8l4.6-3.4M10.2 13.2l4.6 3.4" /></I>;
export const IconActivity = () => <I><path d="M3 12h4l2.5-6 4 12L16 12h5" /></I>;
export const IconKeys = () => <I><circle cx="8" cy="15" r="4" /><path d="M11 12l8-8M15 6l2.5 2.5M18 3l2.5 2.5" /></I>;
export const IconSearch = () => <I><circle cx="11" cy="11" r="6" /><path d="M20 20l-3.5-3.5" /></I>;
export const IconX = () => <I><path d="M6 6l12 12M18 6L6 18" /></I>;
export const IconCheck = () => <I><path d="M4.5 12.5l5 5 10-11" /></I>;
export const IconCopy = () => <I><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 012-2h9" /></I>;
export const IconBolt = () => <I><path d="M13 2L4.5 13.5H11L10 22l8.5-11.5H12L13 2z" /></I>;
export const IconShield = () => <I><path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6l7-3z" /><path d="M9 12l2 2 4-4" /></I>;
export const IconClock = () => <I><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3.5 2" /></I>;
export const IconAlert = () => <I><path d="M12 3l10 17H2L12 3z" /><path d="M12 10v4M12 17.5v.5" /></I>;
export const IconArrowR = () => <I><path d="M4 12h15M14 6l6 6-6 6" /></I>;
export const IconLogout = () => <I><path d="M14 4H6a2 2 0 00-2 2v12a2 2 0 002 2h8" /><path d="M11 12h10M18 8l4 4-4 4" /></I>;
export const IconPlus = () => <I><path d="M12 5v14M5 12h14" /></I>;
export const IconRefresh = () => <I><path d="M20 12a8 8 0 10-2.3 5.6" /><path d="M20 12V6M20 12h-6" /></I>;
export const IconPlay = () => <I><circle cx="12" cy="12" r="8.5" /><path d="M10 8.5l6 3.5-6 3.5v-7z" /></I>;
export const IconStop = () => <I><circle cx="12" cy="12" r="8.5" /><rect x="9" y="9" width="6" height="6" rx="1" /></I>;
export const IconScan = () => <I><path d="M4 8V5a1 1 0 011-1h3M16 4h3a1 1 0 011 1v3M20 16v3a1 1 0 01-1 1h-3M8 20H5a1 1 0 01-1-1v-3" /><circle cx="12" cy="12" r="3" /></I>;
export const IconKey = () => <I><circle cx="8" cy="14" r="4" /><path d="M11.5 10.5L20 2M15.5 6.5l2.5 2.5" /></I>;
