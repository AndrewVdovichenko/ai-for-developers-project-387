export function operationStorage<Context extends { key: string; fingerprint: string }>(
  storageName: string,
  cookieName: string,
  technicalContext: (context: Context) => object = ({ key, fingerprint }) => ({ key, fingerprint }),
) {
  // window.name carries only a random tab identifier across reloads, never a key or form.
  const prefix = 'calendar-tab:';
  if (!/^calendar-tab:[0-9a-f-]{36}$/.test(window.name))
    window.name = `${prefix}${crypto.randomUUID()}`;
  const tabId = window.name.slice(prefix.length);
  storageName = `${storageName}:${tabId}`;
  cookieName = `${cookieName}_${tabId}`;
  type Record = { revision?: number; cleared?: boolean; context?: Context };
  function stores() {
    return [() => window.localStorage, () => window.sessionStorage];
  }
  function latest(): Record | undefined {
    const records: Record[] = [];
    const read = (value: string | null | undefined) => {
      if (!value) return;
      try {
        const parsed = JSON.parse(value) as Record & Context;
        // Existing flat records remain readable during an application upgrade.
        records.push(parsed.key ? { revision: 0, context: parsed } : parsed);
      } catch {
        /* Ignore an unreadable record. */
      }
    };
    for (const storage of stores()) {
      try {
        read(storage().getItem(storageName));
      } catch {
        /* Next store. */
      }
    }
    try {
      const value = document.cookie
        .split('; ')
        .find((item) => item.startsWith(`${cookieName}=`))
        ?.slice(cookieName.length + 1);
      read(value ? decodeURIComponent(value) : undefined);
    } catch {
      /* Cookie unavailable. */
    }
    return records.reduce<Record | undefined>(
      (newest, record) =>
        !newest || (record.revision ?? 0) > (newest.revision ?? 0) ? record : newest,
      undefined,
    );
  }
  function load(): Context | undefined {
    const record = latest();
    return record?.cleared ? undefined : record?.context;
  }
  function writeCookie(record: object) {
    const cookie = encodeURIComponent(JSON.stringify(record));
    try {
      document.cookie = `${cookieName}=${cookie}; Path=/; SameSite=Lax; Max-Age=31536000${location.protocol === 'https:' ? '; Secure' : ''}`;
      return document.cookie.split('; ').includes(`${cookieName}=${cookie}`);
    } catch {
      return false;
    }
  }
  function nextRevision() {
    return Math.max(Date.now(), (latest()?.revision ?? 0) + 1);
  }
  function persist(context: Context) {
    const revision = nextRevision();
    const value = JSON.stringify({ revision, context });
    for (const storage of stores()) {
      try {
        storage().setItem(storageName, value);
        if (storage().getItem(storageName) === value) return true;
      } catch {
        /* Fall back without trusting older readable copies. */
      }
    }
    return writeCookie({ revision, context: technicalContext(context) });
  }
  function clear() {
    // A durable tombstone prevents a read-only stale copy from resurrecting an operation.
    const record = { revision: nextRevision(), cleared: true };
    for (const storage of stores()) {
      try {
        storage().setItem(storageName, JSON.stringify(record));
      } catch {
        /* Next store. */
      }
    }
    writeCookie(record);
  }
  return { load, persist, clear };
}
