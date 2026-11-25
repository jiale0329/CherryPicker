import type { Metadata } from 'next';

import { QueryProvider } from '@/components/providers/query-provider';

import './globals.css';

export const metadata: Metadata = {
  title: 'Release Backport Manager',
  description: 'Track bug fixes across release branches and automate backport pull requests.',
};

/**
 * Dark is the primary theme, so the `dark` class is set here rather than
 * negotiated at runtime. globals.css still defines light values so the app
 * stays legible if the class is removed.
 *
 * Fonts use a system stack deliberately: next/font/google downloads at build
 * time, which fails on this network because Zscaler intercepts TLS and the
 * build would depend on the CA bundle being present.
 */
export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className="dark h-full">
      <body className="flex min-h-full flex-col antialiased">
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  );
}
