export const metadata = {
  title: "Story → Video Assembler",
  description: "Assemble an MP4 from timestamp-named images and one voiceover.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
