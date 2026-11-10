import { ScrollViewStyleReset } from "expo-router/html";
import type { PropsWithChildren } from "react";

/**
 * The theme preference is the only value mirrored to localStorage (never tokens or business data).
 * Reading it inline prevents a light flash before the app hydrates, including when the site is opened
 * with a saved dark theme.
 */
const boot = `
(function(){
  try {
    var mode = localStorage.getItem('theme_mode') || 'system';
    var dark = mode === 'dark' || (mode === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    document.documentElement.style.backgroundColor = dark ? '#0D1520' : '#F6F8FA';
    document.documentElement.style.transition = 'background-color 160ms ease';
  } catch (e) {}
})();
`;

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en"><head>
      <meta charSet="utf-8" /><meta httpEquiv="X-UA-Compatible" content="IE=edge" />
      <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />
      <link rel="manifest" href="/manifest.json" /><meta name="theme-color" content="#0F5C4D" /><meta name="apple-mobile-web-app-title" content="Idukaa" />
      <ScrollViewStyleReset />
      <script dangerouslySetInnerHTML={{ __html: boot }} />
      <script dangerouslySetInnerHTML={{ __html: "if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js')})}" }} />
    </head><body>{children}</body></html>
  );
}
