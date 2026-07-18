import { redirect } from 'next/navigation';

const PUBLIC_SITE_URL = 'https://www.inkmarshal.com';

export default function Home() {
  if (process.env.NODE_ENV === 'production' && process.env.INKMARSHAL_RUNTIME !== 'desktop') {
    redirect(PUBLIC_SITE_URL);
  }
  redirect('/desktop-studio');
}
