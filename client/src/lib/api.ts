const BASE = import.meta.env.BASE_URL.replace(/\/$/, '')
const ADMIN_KEY_STORAGE = 'freellmapi.adminDashboardKey'

function getAdminApiKey(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(ADMIN_KEY_STORAGE)
}

function setAdminApiKey(key: string): void {
  localStorage.setItem(ADMIN_KEY_STORAGE, key)
}

function clearAdminApiKey(): void {
  localStorage.removeItem(ADMIN_KEY_STORAGE)
}

function promptForAdminApiKey(): string | null {
  const key = window.prompt('Admin API key')
  const trimmed = key?.trim()
  if (!trimmed) return null
  setAdminApiKey(trimmed)
  return trimmed
}

function buildHeaders(path: string, headers?: HeadersInit): Headers {
  const nextHeaders = new Headers(headers)
  nextHeaders.set('Content-Type', nextHeaders.get('Content-Type') ?? 'application/json')

  if (path.startsWith('/api/')) {
    const adminKey = getAdminApiKey()
    if (adminKey) nextHeaders.set('Authorization', `Bearer ${adminKey}`)
  }

  return nextHeaders
}

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  if (path.startsWith('/api/') && !getAdminApiKey()) {
    promptForAdminApiKey()
  }

  const requestOptions: RequestInit = {
    ...options,
    headers: buildHeaders(path, options?.headers),
  }

  let res = await fetch(`${BASE}${path}`, requestOptions)
  if (res.status === 401 && path.startsWith('/api/')) {
    clearAdminApiKey()
    const adminKey = promptForAdminApiKey()
    if (adminKey) {
      const retryHeaders = buildHeaders(path, options?.headers)
      retryHeaders.set('Authorization', `Bearer ${adminKey}`)
      res = await fetch(`${BASE}${path}`, { ...options, headers: retryHeaders })
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: { message: res.statusText } }))
    throw new Error(body.error?.message ?? `HTTP ${res.status}`)
  }
  return res.json()
}
