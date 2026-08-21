export const metadata = {
  title: "TryAIToday AutoEditor — image + video · voiceover sync",
  description: "Sync timestamp-named images and video clips to a voiceover and export an MP4, on your device.",
  icons: { icon: "/logo.svg" },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
