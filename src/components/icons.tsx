// Minimal geometric icon set — deliberate placeholders, all in one file.
// Swap any of these for custom icons without touching the pages that use them.
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;

const base = (props: P) => ({
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "currentColor",
  "aria-hidden": true,
  ...props,
});

export const PlayIcon = (props: P) => (
  <svg {...base(props)}>
    <path d="M8 5v14l11-7z" />
  </svg>
);

export const PauseIcon = (props: P) => (
  <svg {...base(props)}>
    <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
  </svg>
);

export const PrevIcon = (props: P) => (
  <svg {...base(props)}>
    <path d="M6 5h2v14H6zM20 5v14l-10-7z" />
  </svg>
);

export const NextIcon = (props: P) => (
  <svg {...base(props)}>
    <path d="M16 5h2v14h-2zM4 5v14l10-7z" />
  </svg>
);

export const DownloadIcon = (props: P) => (
  <svg {...base(props)}>
    <path d="M11 4h2v8.2l3.1-3.1 1.4 1.4L12 16 6.5 10.5l1.4-1.4L11 12.2zM5 18h14v2H5z" />
  </svg>
);

export const CheckIcon = (props: P) => (
  <svg {...base(props)}>
    <path d="M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6 12-12L20.1 5.6z" />
  </svg>
);

export const MenuIcon = (props: P) => (
  <svg {...base(props)}>
    <path d="M4 6h16v2H4zM4 11h16v2H4zM4 16h16v2H4z" />
  </svg>
);

export const TuneIcon = (props: P) => (
  <svg {...base(props)}>
    <path d="M4 6h9v2H4zM17 6h3v2h-3zM13 5h2v4h-2zM4 11h3v2H4zM11 11h9v2h-9zM7 10h2v4H7zM4 16h11v2H4zM19 16h1v2h-1zM15 15h2v4h-2z" />
  </svg>
);
