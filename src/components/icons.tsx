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

export const HeadphonesIcon = (props: P) => (
  <svg {...base(props)}>
    <path d="M12 3a9 9 0 0 0-9 9v6a2 2 0 0 0 2 2h2v-8H5v-0a7 7 0 0 1 14 0h-2v8h2a2 2 0 0 0 2-2v-6a9 9 0 0 0-9-9z" />
  </svg>
);

export const MenuIcon = (props: P) => (
  <svg {...base(props)}>
    <path d="M4 6h16v2H4zM4 11h16v2H4zM4 16h16v2H4z" />
  </svg>
);

export const BookmarkIcon = (props: P) => (
  <svg {...base(props)}>
    <path d="M6 3h12v18l-6-4-6 4z" />
  </svg>
);

export const SearchIcon = (props: P) => (
  <svg {...base(props)}>
    <path d="M10 3a7 7 0 1 0 4.2 12.6l5.1 5.1 1.4-1.4-5.1-5.1A7 7 0 0 0 10 3zm0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10z" />
  </svg>
);

export const CloseIcon = (props: P) => (
  <svg {...base(props)}>
    <path d="m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4z" />
  </svg>
);

export const ChevronUpIcon = (props: P) => (
  <svg {...base(props)}>
    <path d="m12 8 7 7-1.4 1.4-5.6-5.6-5.6 5.6L5 15z" />
  </svg>
);

export const ChevronDownIcon = (props: P) => (
  <svg {...base(props)}>
    <path d="m12 16-7-7 1.4-1.4 5.6 5.6 5.6-5.6L19 9z" />
  </svg>
);

export const TuneIcon = (props: P) => (
  <svg {...base(props)}>
    <path d="M4 6h9v2H4zM17 6h3v2h-3zM13 5h2v4h-2zM4 11h3v2H4zM11 11h9v2h-9zM7 10h2v4H7zM4 16h11v2H4zM19 16h1v2h-1zM15 15h2v4h-2z" />
  </svg>
);
