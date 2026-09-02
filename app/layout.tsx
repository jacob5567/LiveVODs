import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'LiveVODs',
  description: 'A DVR-style TV guide for Twitch and YouTube live streams',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
