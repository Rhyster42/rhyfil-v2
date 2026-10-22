// A tiny hash router: #/register, #/orders/<id>, #/office/<tab>.
import { useCallback, useEffect, useState } from 'react';

export type Route =
  | { screen: 'register' }
  | { screen: 'orders'; orderId?: string }
  | { screen: 'office'; tab: string };

export function parseHash(hash: string): Route {
  const [screen, arg] = hash.replace(/^#\/?/, '').split('/');
  if (screen === 'orders') return { screen, orderId: arg || undefined };
  if (screen === 'office') return { screen, tab: arg || 'reports' };
  return { screen: 'register' };
}

export function routeHash(r: Route): string {
  switch (r.screen) {
    case 'register':
      return '#/register';
    case 'orders':
      return r.orderId ? `#/orders/${r.orderId}` : '#/orders';
    case 'office':
      return `#/office/${r.tab}`;
  }
}

export function useRoute(): [Route, (r: Route) => void] {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const navigate = useCallback((r: Route) => {
    window.location.hash = routeHash(r);
    setHash(routeHash(r));
  }, []);
  return [parseHash(hash), navigate];
}
