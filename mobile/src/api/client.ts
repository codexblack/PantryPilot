import Constants from 'expo-constants';
import { fetch as expoFetch } from 'expo/fetch';
import { File as ExpoFile } from 'expo-file-system';
import { Platform } from 'react-native';

import { getAppCheckToken } from './appCheck';
import type {
  DietaryProfile,
  Ingredient,
  PlanResponse,
  RecipeImage,
  ScanResponse,
  StoreLookupResponse,
} from '../types';

const MODEL_REQUEST_TIMEOUT_MS = 330_000;
const STORE_LOOKUP_TIMEOUT_MS = 30_000;
const RECIPE_IMAGE_TIMEOUT_MS = 45_000;
const RECIPE_IMAGE_CACHE_LIMIT = 12;
const RECIPE_IMAGE_MISS_TTL_MS = 60_000;
const recipeImageRequests = new Map<string, Promise<RecipeImage | null>>();
const recipeImageMemory = new Map<string, { image: RecipeImage | null; expiresAt?: number }>();

function getCachedRecipeImage(cacheKey: string) {
  const entry = recipeImageMemory.get(cacheKey);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
    recipeImageMemory.delete(cacheKey);
    return undefined;
  }
  recipeImageMemory.delete(cacheKey);
  recipeImageMemory.set(cacheKey, entry);
  return entry.image;
}

function cacheRecipeImage(cacheKey: string, image: RecipeImage | null) {
  recipeImageMemory.delete(cacheKey);
  recipeImageMemory.set(cacheKey, {
    image,
    expiresAt: image === null ? Date.now() + RECIPE_IMAGE_MISS_TTL_MS : undefined,
  });
  while (recipeImageMemory.size > RECIPE_IMAGE_CACHE_LIMIT) {
    const oldestKey = recipeImageMemory.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    recipeImageMemory.delete(oldestKey);
  }
}

function configuredApiUrl() {
  const value = process.env.EXPO_PUBLIC_API_URL?.trim();
  return value ? value.replace(/\/$/, '') : null;
}

function expoDevelopmentApiUrl() {
  const hostUri = Constants.expoConfig?.hostUri ?? Constants.expoGoConfig?.debuggerHost;
  if (!hostUri) {
    return null;
  }
  try {
    const hostname = new URL(hostUri.includes('://') ? hostUri : `http://${hostUri}`).hostname;
    if (!hostname || hostname === 'localhost' || hostname === '127.0.0.1') {
      return null;
    }
    return `http://${hostname}:8000`;
  } catch {
    return null;
  }
}

function apiUrl(path: string) {
  const baseUrl = configuredApiUrl() ?? expoDevelopmentApiUrl();
  if (!baseUrl) {
    throw new Error(
      'API URL is not configured. Create mobile/.env with EXPO_PUBLIC_API_URL=http://YOUR_COMPUTER_LAN_IP:8000, then restart Expo.',
    );
  }
  return `${baseUrl}${path}`;
}

type RequestOptions = {
  signal?: AbortSignal;
};

async function requestHeaders(headers?: Record<string, string>) {
  const token = await getAppCheckToken();
  return token ? { ...headers, 'X-Firebase-AppCheck': token } : headers;
}

async function fetchWithTimeout(
  url: string,
  init?: Parameters<typeof expoFetch>[1],
  timeoutMs = MODEL_REQUEST_TIMEOUT_MS,
  externalSignal?: AbortSignal,
) {
  if (externalSignal?.aborted) {
    throw new Error('Request cancelled.');
  }
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  externalSignal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await expoFetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (externalSignal?.aborted) {
      throw new Error('Request cancelled.');
    }
    if (controller.signal.aborted) {
      throw new Error(
        `The API did not respond within ${Math.round(timeoutMs / 1000)} seconds at ${new URL(url).origin}. Check your internet connection and the API service status.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', abortFromCaller);
  }
}

export type SelectedMedia = {
  uri: string;
  fileName?: string | null;
  mimeType?: string | null;
  file?: File;
};

async function responseOrError<T>(response: Response): Promise<T> {
  if (response.ok) {
    return response.json() as Promise<T>;
  }
  const payload = await response.json().catch(() => null);
  throw new Error(payload?.detail ?? `Something went wrong (${response.status}).`);
}

function appendMedia(
  form: FormData,
  field: 'video' | 'images',
  media: SelectedMedia,
  fallbackName: string,
) {
  const file = Platform.OS === 'web' && media.file ? media.file : new ExpoFile(media.uri);
  form.append(field, file, media.fileName ?? fallbackName);
}

export async function uploadScan(
  input: { video?: SelectedMedia; images?: SelectedMedia[] },
  options: RequestOptions = {},
): Promise<ScanResponse> {
  if (Boolean(input.video) === Boolean(input.images?.length)) {
    throw new Error('Choose exactly one video or one to four photos.');
  }
  if (input.images && (input.images.length < 1 || input.images.length > 4)) {
    throw new Error('Choose between 1 and 4 photos.');
  }
  const form = new FormData();
  if (input.video) {
    appendMedia(form, 'video', input.video, 'pantry-walkthrough.mp4');
  } else {
    input.images?.forEach((image, index) =>
      appendMedia(form, 'images', image, `pantry-photo-${index + 1}.jpg`),
    );
  }
  const response = await fetchWithTimeout(
    apiUrl('/v1/scan'),
    { method: 'POST', headers: await requestHeaders(), body: form },
    MODEL_REQUEST_TIMEOUT_MS,
    options.signal,
  );
  return responseOrError<ScanResponse>(response);
}

export async function requestPlan(
  input: {
    cuisine: string;
    ingredients: Ingredient[];
    staples: string[];
    dietary: DietaryProfile;
    taste_profile?: string | null;
    exclude_recipe_titles?: string[];
  },
  options: RequestOptions = {},
): Promise<PlanResponse> {
  const response = await fetchWithTimeout(
    apiUrl('/v1/plan'),
    {
      method: 'POST',
      headers: await requestHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(input),
    },
    MODEL_REQUEST_TIMEOUT_MS,
    options.signal,
  );
  return responseOrError<PlanResponse>(response);
}

export async function requestStores(
  input: {
    items: string[];
    location: { latitude: number; longitude: number };
  },
  options: RequestOptions = {},
): Promise<StoreLookupResponse> {
  const response = await fetchWithTimeout(
    apiUrl('/v1/stores'),
    {
      method: 'POST',
      headers: await requestHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(input),
    },
    STORE_LOOKUP_TIMEOUT_MS,
    options.signal,
  );
  return responseOrError<StoreLookupResponse>(response);
}

export async function getRecipeImage(title: string): Promise<RecipeImage | null> {
  const cacheKey = title.trim().toLowerCase();
  const cached = getCachedRecipeImage(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const inFlight = recipeImageRequests.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const request = (async () => {
    const response = await fetchWithTimeout(
      apiUrl('/v1/recipe-images'),
      {
        method: 'POST',
        headers: await requestHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ title }),
      },
      RECIPE_IMAGE_TIMEOUT_MS,
    );
    const payload = await responseOrError<{ image?: RecipeImage | null }>(response);
    const image = payload.image ?? null;
    cacheRecipeImage(cacheKey, image);
    return image;
  })();
  recipeImageRequests.set(cacheKey, request);
  try {
    return await request;
  } finally {
    recipeImageRequests.delete(cacheKey);
  }
}
