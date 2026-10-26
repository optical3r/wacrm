import { ImageResponse } from "next/og";

// Favicon: the LabCRM mark (mint tile + chat bubble with an "L"),
// matching <LabCrmMark /> in src/components/brand/labcrm-mark.tsx.
// Next.js renders this at build time and auto-injects <link rel="icon">.

export const runtime = "edge";
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <svg width="32" height="32" viewBox="0 0 64 64">
        <defs>
          <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#5eead4" />
            <stop offset="1" stopColor="#2dd4bf" />
          </linearGradient>
        </defs>
        <rect width="64" height="64" rx="16" fill="url(#g)" />
        <path
          fill="#0b1613"
          d="M22 12h20c6.6 0 12 5.4 12 12v10c0 6.6-5.4 12-12 12H26l-9.2 7.4c-1.3 1-3.2.1-3.2-1.6V45.2C11.4 43 10 39.7 10 36V24c0-6.6 5.4-12 12-12z"
        />
        <path
          d="M24 20.5v16h15"
          fill="none"
          stroke="#5eead4"
          strokeWidth="5.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="41.5" cy="22.5" r="4" fill="#5eead4" />
      </svg>
    ),
    { ...size },
  );
}
