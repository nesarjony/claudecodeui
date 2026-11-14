import { useEffect, useState } from 'react';

/** Used by the connection banner to tell a lost network apart from Foreman not answering. */
export function useOnline(): boolean {
  // Follows the browser's online and offline events; the banner needs it to re-render when the network drops.
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);
  return online;
}
