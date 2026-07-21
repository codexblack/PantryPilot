import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  Easing,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { File as ExpoFile } from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import {
  getRecipeImage,
  requestPlan,
  requestStores,
  uploadScan,
  type SelectedMedia,
} from './src/api/client';
import { DietaryMarks } from './src/components/DietaryMarks';
import { FastPerishingGauge } from './src/components/FastPerishingGauge';
import { IngredientChip } from './src/components/IngredientChip';
import { RecipeDishImage } from './src/components/RecipeDishImage';
import { colors, shadow } from './src/constants/theme';
import {
  deleteSavedRecipe,
  getSavedRecipes,
  saveRecipe,
  updateRecipeImage,
  updateRecipeNotes,
  type SavedRecipe,
} from './src/storage/recipes';
import type {
  DietaryChoice,
  DietaryProfile,
  Ingredient,
  PlanResponse,
  RecipeImage,
} from './src/types';

const SURPRISE_CUISINE = 'Surprise Me';
const CUISINES = [
  SURPRISE_CUISINE,
  'Italian',
  'Mexican',
  'Indian',
  'Japanese',
  'Korean',
  'Mediterranean',
  'Thai',
  'Chinese',
  'Peruvian',
  'French',
  'Greek',
  'Spanish',
  'Vietnamese',
  'Turkish',
  'Caribbean',
  'American',
];
const DEFAULT_STAPLES = ['cooking oil', 'salt', 'pepper', 'sugar'];
const DIETARY_OPTIONS: {
  value: DietaryChoice;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
}[] = [
  { value: 'vegan', label: 'Vegan', icon: 'leaf-outline' },
  { value: 'vegetarian', label: 'Vegetarian', icon: 'nutrition-outline' },
  { value: 'keto', label: 'Keto-friendly', icon: 'flash-outline' },
];
const MAX_VIDEO_BYTES = 28 * 1024 * 1024;
const MAX_PHOTO_BYTES = 7 * 1024 * 1024;
const MAX_PHOTO_SET_BYTES = 28 * 1024 * 1024;
const MAX_PREPARED_PHOTO_EDGE = 1280;
const MAX_CONCURRENT_PHOTO_PREPARATIONS = 2;
const MAX_EXCLUDED_RECIPE_TITLES = 12;
const LOCATION_TIMEOUT_MS = 12_000;
const NOTE_WORD_LIMIT = 20;
const NOTE_CHARACTER_LIMIT = 160;
const TASTE_PROFILE_WORD_LIMIT = 10;
const TASTE_PROFILE_CHARACTER_LIMIT = 80;

type PendingMedia = SelectedMedia & {
  id: string;
  label: string;
  temporary?: boolean;
};

type PendingScan = {
  kind: 'video' | 'images';
  items: PendingMedia[];
};

type AppPage = 'mood' | 'pantry';

function titleCase(value: string) {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function appendShownRecipeTitle(titles: string[], title: string) {
  const normalizedTitle = title.trim().toLowerCase();
  return [
    ...titles.filter((candidate) => candidate.trim().toLowerCase() !== normalizedTitle),
    title,
  ].slice(-MAX_EXCLUDED_RECIPE_TITLES);
}

function getCurrentPosition(signal: AbortSignal): Promise<Location.LocationObject> {
  if (signal.aborted) {
    return Promise.reject(new Error('Location request cancelled.'));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', handleAbort);
    };
    const resolveOnce = (position: Location.LocationObject) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(position);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const handleAbort = () => rejectOnce(new Error('Location request cancelled.'));

    signal.addEventListener('abort', handleAbort, { once: true });
    const timeout = setTimeout(
      () => rejectOnce(new Error('Location lookup timed out. Please try again.')),
      LOCATION_TIMEOUT_MS,
    );
    void Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }).then(
      resolveOnce,
      rejectOnce,
    );
  });
}

function openAppSettings() {
  void Linking.openSettings().catch(() => undefined);
}

function toSelectedMedia(asset: ImagePicker.ImagePickerAsset): SelectedMedia {
  return {
    uri: asset.uri,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    // Expo documents this File as web-only. Native upload wraps the URI in ExpoFile later.
    file: Platform.OS === 'web' ? asset.file : undefined,
  };
}

function toPendingMedia(
  asset: ImagePicker.ImagePickerAsset,
  index: number,
  fallbackName: string,
): PendingMedia {
  return {
    ...toSelectedMedia(asset),
    id: `${asset.assetId ?? asset.uri}-${index}`,
    label: asset.fileName ?? fallbackName,
  };
}

async function preparePendingPhoto(
  asset: ImagePicker.ImagePickerAsset,
  index: number,
): Promise<PendingMedia> {
  const fallbackName = `pantry-photo-${index + 1}.jpg`;
  if (Platform.OS === 'web') {
    return toPendingMedia(asset, index, fallbackName);
  }

  const context = ImageManipulator.ImageManipulator.manipulate(asset.uri);
  if (Math.max(asset.width, asset.height) > MAX_PREPARED_PHOTO_EDGE) {
    if (asset.width >= asset.height) {
      context.resize({ width: MAX_PREPARED_PHOTO_EDGE, height: null });
    } else {
      context.resize({ width: null, height: MAX_PREPARED_PHOTO_EDGE });
    }
  }
  const rendered = await context.renderAsync();
  const prepared = await rendered.saveAsync({
    compress: 0.78,
    format: ImageManipulator.SaveFormat.JPEG,
  });
  return {
    uri: prepared.uri,
    fileName: fallbackName,
    mimeType: 'image/jpeg',
    id: `${asset.assetId ?? asset.uri}-${index}`,
    label: asset.fileName ?? fallbackName,
    temporary: true,
  };
}

function deleteTemporaryMedia(media: PendingMedia | undefined) {
  if (!media?.temporary || Platform.OS === 'web') {
    return;
  }
  try {
    new ExpoFile(media.uri).delete();
  } catch {
    // Cache cleanup is best-effort; Expo may already have evicted the file.
  }
}

function deleteTemporaryMediaBatch(items: readonly PendingMedia[]) {
  items.forEach(deleteTemporaryMedia);
}

async function preparePendingPhotos(
  assets: ImagePicker.ImagePickerAsset[],
  isCurrent: () => boolean,
): Promise<PendingMedia[] | null> {
  const prepared: (PendingMedia | undefined)[] = new Array(assets.length);
  let nextIndex = 0;
  let failure: unknown;

  const worker = async () => {
    while (isCurrent() && failure === undefined) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= assets.length) {
        return;
      }
      try {
        const media = await preparePendingPhoto(assets[index], index);
        if (!isCurrent()) {
          deleteTemporaryMedia(media);
          return;
        }
        prepared[index] = media;
      } catch (error) {
        failure = error;
      }
    }
  };

  const workerCount = Math.min(MAX_CONCURRENT_PHOTO_PREPARATIONS, assets.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  const completed = prepared.filter((media): media is PendingMedia => media !== undefined);
  if (!isCurrent() || failure !== undefined) {
    deleteTemporaryMediaBatch(completed);
    if (failure !== undefined) {
      throw failure;
    }
    return null;
  }
  return completed;
}

export default function App() {
  const { width } = useWindowDimensions();
  const [cuisine, setCuisine] = useState('Italian');
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [staples, setStaples] = useState(DEFAULT_STAPLES);
  const [dietary, setDietary] = useState<DietaryProfile>({
    diet: 'none',
    gluten_free: false,
    oven_available: false,
  });
  const [tasteProfile, setTasteProfile] = useState('');
  const [activePage, setActivePage] = useState<AppPage>('mood');
  const [recipeOpen, setRecipeOpen] = useState(false);
  const [scanNotice, setScanNotice] = useState<string | null>(null);
  const [pendingScan, setPendingScan] = useState<PendingScan | null>(null);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [planGeneratedAt, setPlanGeneratedAt] = useState<string | null>(null);
  const [recipeImage, setRecipeImage] = useState<RecipeImage | null | undefined>(undefined);
  const [savingRecipe, setSavingRecipe] = useState(false);
  const [preparingPhotos, setPreparingPhotos] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [loadingStores, setLoadingStores] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cuisinePickerOpen, setCuisinePickerOpen] = useState(false);
  const [addIngredientOpen, setAddIngredientOpen] = useState(false);
  const [draftIngredient, setDraftIngredient] = useState('');
  const [draftQuantity, setDraftQuantity] = useState('');
  const [draftExpiresSoon, setDraftExpiresSoon] = useState(false);
  const [editingIngredientIndex, setEditingIngredientIndex] = useState<number | null>(null);
  const [savedTitles, setSavedTitles] = useState<string[]>([]);
  const [savedRecipes, setSavedRecipes] = useState<SavedRecipe[]>([]);
  const [savedRecipesOpen, setSavedRecipesOpen] = useState(false);
  const [selectedSavedRecipe, setSelectedSavedRecipe] = useState<SavedRecipe | null>(null);
  const [shownRecipeTitles, setShownRecipeTitles] = useState<string[]>([]);
  const requestInFlight = useRef(false);
  const activeRequestController = useRef<AbortController | null>(null);
  const storeRequestController = useRef<AbortController | null>(null);
  const photoPreparationVersion = useRef(0);
  const photoPreparationInFlight = useRef(false);
  const scrollRef = useRef<ScrollView>(null);
  const pageSlide = useRef(new Animated.Value(0)).current;
  const pageTransitioning = useRef(false);

  useEffect(() => {
    getSavedRecipes()
      .then((recipes) => {
        setSavedRecipes(recipes);
        setSavedTitles(recipes.map((entry) => entry.recipe.title));
      })
      .catch(() => undefined);
  }, []);

  const contentWidth = Math.min(width - 32, 680);
  const makeToday = new Date().getHours() >= 6 && new Date().getHours() < 18;
  const expiringCount = ingredients.filter(
    (ingredient) => ingredient.freshness === 'use_soon',
  ).length;
  const isRequestProcessing = scanning || planning || loadingStores;
  const isProcessing = preparingPhotos || isRequestProcessing || cancelling;
  const hasPlanInput = ingredients.length > 0 || Boolean(pendingScan?.items.length);
  const canPlan = hasPlanInput && !isProcessing;
  const canOpenOrCreatePlan = Boolean(plan) ? !isProcessing : canPlan;
  const mediaControlsLocked = isProcessing;
  const selectedDiet = DIETARY_OPTIONS.find((option) => option.value === dietary.diet);
  const preferenceSummary = [
    selectedDiet?.label.toLowerCase(),
    dietary.gluten_free ? 'gluten-free' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const cuisineSubtitle =
    cuisine === SURPRISE_CUISINE
      ? `any cuisine · ${preferenceSummary || 'open to all'}`
      : preferenceSummary || 'open to all';

  const navigateToPage = useCallback(
    (nextPage: AppPage) => {
      if (nextPage === activePage || pageTransitioning.current || isProcessing) {
        return;
      }
      pageTransitioning.current = true;
      const travelDistance = Math.max(width, contentWidth);
      const exitX = nextPage === 'pantry' ? -travelDistance : travelDistance;
      Animated.timing(pageSlide, {
        toValue: exitX,
        duration: 155,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (!finished) {
          pageTransitioning.current = false;
          return;
        }
        setActivePage(nextPage);
        scrollRef.current?.scrollTo({ y: 0, animated: false });
        pageSlide.setValue(-exitX);
        Animated.timing(pageSlide, {
          toValue: 0,
          duration: 185,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }).start(() => {
          pageTransitioning.current = false;
        });
      });
    },
    [activePage, contentWidth, isProcessing, pageSlide, width],
  );

  const pagePanResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_event, gesture) => {
          if (pageTransitioning.current || isProcessing) {
            return false;
          }
          const isHorizontalSwipe =
            Math.abs(gesture.dx) > 12 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.2;
          if (!isHorizontalSwipe) {
            return false;
          }
          return (
            (gesture.dx < 0 && activePage === 'mood') || (gesture.dx > 0 && activePage === 'pantry')
          );
        },
        onPanResponderRelease: (_event, gesture) => {
          if (gesture.dx <= -36 && activePage === 'mood') {
            navigateToPage('pantry');
          }
          if (gesture.dx >= 36 && activePage === 'pantry') {
            navigateToPage('mood');
          }
        },
        onPanResponderTerminate: () => undefined,
      }),
    [activePage, isProcessing, navigateToPage],
  );

  async function selectVideo(source: 'camera' | 'library') {
    if (isProcessing) {
      return;
    }
    const permission =
      source === 'camera'
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(
        'Permission needed',
        source === 'camera'
          ? 'Camera access lets you record a pantry walkthrough.'
          : 'Media access lets you choose a pantry walkthrough.',
      );
      return;
    }

    const result =
      source === 'camera'
        ? await ImagePicker.launchCameraAsync({
            mediaTypes: ['videos'],
            cameraType: ImagePicker.CameraType.back,
            videoMaxDuration: 35,
          })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['videos'] });
    if (result.canceled || !result.assets?.[0]) {
      return;
    }

    const asset = result.assets[0];
    if (asset.duration && asset.duration > 35_000) {
      Alert.alert('Keep it short', 'Please choose a walkthrough of 35 seconds or less.');
      return;
    }
    if (asset.fileSize && asset.fileSize > MAX_VIDEO_BYTES) {
      Alert.alert('Video is too large', 'Please choose a video under 28 MB.');
      return;
    }

    if (pendingScan) {
      deleteTemporaryMediaBatch(pendingScan.items);
    }
    setPlan(null);
    setPendingScan({ kind: 'video', items: [toPendingMedia(asset, 0, 'pantry-walkthrough.mp4')] });
    setScanNotice('Video selected. You can remove it or tap Find my dish when you are ready.');
  }

  async function selectPhotos() {
    if (isProcessing || photoPreparationInFlight.current) {
      return;
    }
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission needed', 'Media access lets you choose up to four pantry photos.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      orderedSelection: true,
      selectionLimit: 4,
      quality: 0.9,
    });
    if (result.canceled || !result.assets?.length) {
      return;
    }
    if (result.assets.length > 4) {
      Alert.alert(
        'Choose up to 4 photos',
        'For a faster, more reliable scan, choose no more than four photos.',
      );
      return;
    }
    const totalSize = result.assets.reduce((total, asset) => total + (asset.fileSize ?? 0), 0);
    if (result.assets.some((asset) => asset.fileSize && asset.fileSize > MAX_PHOTO_BYTES)) {
      Alert.alert('Photo is too large', 'Each photo must be under 7 MB.');
      return;
    }
    if (totalSize > MAX_PHOTO_SET_BYTES) {
      Alert.alert('Photo set is too large', 'Keep all selected photos under 28 MB total.');
      return;
    }

    const preparationVersion = photoPreparationVersion.current + 1;
    photoPreparationVersion.current = preparationVersion;
    photoPreparationInFlight.current = true;
    setPreparingPhotos(true);
    try {
      const preparedPhotos = await preparePendingPhotos(
        result.assets,
        () => photoPreparationVersion.current === preparationVersion,
      );
      if (!preparedPhotos) {
        return;
      }
      if (pendingScan) {
        deleteTemporaryMediaBatch(pendingScan.items);
      }
      setPlan(null);
      setPendingScan({ kind: 'images', items: preparedPhotos });
      setScanNotice(
        `${preparedPhotos.length} photo${preparedPhotos.length === 1 ? '' : 's'} selected. You can remove any photo or tap Find my dish when you are ready.`,
      );
    } catch {
      if (photoPreparationVersion.current === preparationVersion) {
        Alert.alert(
          'Could not prepare those photos',
          'Choose standard JPEG, PNG, or HEIC photos and try again.',
        );
      }
    } finally {
      photoPreparationInFlight.current = false;
      setPreparingPhotos(false);
      setCancelling(false);
    }
  }

  function removePendingMedia(id: string) {
    deleteTemporaryMedia(pendingScan?.items.find((item) => item.id === id));
    setPendingScan((current) => {
      if (!current) {
        return null;
      }
      const items = current.items.filter((item) => item.id !== id);
      return items.length ? { ...current, items } : null;
    });
    setPlan(null);
  }

  function clearPendingScan() {
    if (pendingScan) {
      deleteTemporaryMediaBatch(pendingScan.items);
    }
    setPendingScan(null);
    setScanNotice(null);
    setPlan(null);
  }

  function openIngredientEditor(index?: number) {
    const ingredient = index === undefined ? null : ingredients[index];
    setEditingIngredientIndex(index ?? null);
    setDraftIngredient(ingredient?.name ?? '');
    setDraftQuantity(ingredient?.quantity ?? '');
    setDraftExpiresSoon(ingredient?.freshness === 'use_soon');
    setAddIngredientOpen(true);
  }

  function closeIngredientEditor() {
    setAddIngredientOpen(false);
    setDraftIngredient('');
    setDraftQuantity('');
    setDraftExpiresSoon(false);
    setEditingIngredientIndex(null);
  }

  function saveIngredient() {
    const name = draftIngredient.trim();
    if (!name) {
      return;
    }
    const quantity = draftQuantity.trim() || null;
    setIngredients((current) => {
      const next = {
        name: titleCase(name),
        normalized_name: name.toLowerCase(),
        quantity,
        confidence: 1,
      };
      if (editingIngredientIndex === null) {
        return [
          ...current,
          { ...next, freshness: draftExpiresSoon ? ('use_soon' as const) : ('unknown' as const) },
        ];
      }
      return current.map((item, index) =>
        index === editingIngredientIndex
          ? {
              ...item,
              ...next,
              confidence: item.confidence,
              freshness: draftExpiresSoon
                ? ('use_soon' as const)
                : item.freshness === 'use_soon'
                  ? ('unknown' as const)
                  : item.freshness,
              opened: item.opened,
            }
          : item,
      );
    });
    closeIngredientEditor();
    setPlan(null);
  }

  function removeEditingIngredient() {
    if (editingIngredientIndex === null) {
      return;
    }
    setIngredients((current) => current.filter((_, index) => index !== editingIngredientIndex));
    closeIngredientEditor();
    setPlan(null);
  }

  function toggleStaple(staple: string) {
    setStaples((current) =>
      current.includes(staple) ? current.filter((item) => item !== staple) : [...current, staple],
    );
    setPlan(null);
  }

  function abortActiveRequest() {
    let cancelled = false;
    if (preparingPhotos && photoPreparationInFlight.current) {
      photoPreparationVersion.current += 1;
      cancelled = true;
    }
    const controller = activeRequestController.current;
    if (controller && !controller.signal.aborted) {
      controller.abort();
      cancelled = true;
    }
    const storeController = storeRequestController.current;
    if (storeController && !storeController.signal.aborted) {
      storeController.abort();
      cancelled = true;
    }
    if (cancelled) {
      setCancelling(true);
    }
  }

  async function getPlan(tryAnother = false) {
    if (!canPlan || requestInFlight.current) {
      return;
    }
    const controller = new AbortController();
    activeRequestController.current = controller;
    requestInFlight.current = true;
    setCancelling(false);
    setPlanning(true);
    setRegenerating(tryAnother);
    let stage: 'scan' | 'plan' = 'plan';
    try {
      let planIngredients = ingredients;
      if (!tryAnother && pendingScan) {
        stage = 'scan';
        setScanning(true);
        const inventoryCountBeforeScan = ingredients.length;
        const response = await uploadScan(
          pendingScan.kind === 'video'
            ? { video: pendingScan.items[0] }
            : { images: pendingScan.items },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) {
          return;
        }
        deleteTemporaryMediaBatch(pendingScan.items);
        planIngredients = response.ingredients;
        setIngredients(() => planIngredients);
        setPendingScan(null);
        const replacementNotice = inventoryCountBeforeScan
          ? `Replaced ${inventoryCountBeforeScan} existing inventory item${inventoryCountBeforeScan === 1 ? '' : 's'}. `
          : '';
        setScanNotice(
          `${replacementNotice}${response.notice ?? `Reviewed ${response.frames_analyzed} selected view${response.frames_analyzed === 1 ? '' : 's'}.`}`,
        );
        setScanning(false);
        stage = 'plan';
      }
      if (!planIngredients.length) {
        throw new Error('Add inventory or select a photo/video before finding a dish.');
      }
      if (controller.signal.aborted) {
        return;
      }
      const response = await requestPlan(
        {
          cuisine,
          ingredients: planIngredients,
          staples,
          dietary,
          taste_profile: tasteProfile.trim() || undefined,
          exclude_recipe_titles: tryAnother
            ? shownRecipeTitles.slice(-MAX_EXCLUDED_RECIPE_TITLES)
            : [],
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) {
        return;
      }
      setPlan(response);
      setRecipeImage(undefined);
      setRecipeOpen(true);
      setPlanGeneratedAt(response.recipe ? new Date().toISOString() : null);
      const recipeTitle = response.recipe?.title;
      if (recipeTitle) {
        setShownRecipeTitles((current) =>
          tryAnother ? appendShownRecipeTitle(current, recipeTitle) : [recipeTitle],
        );
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        Alert.alert(
          stage === 'scan' ? 'Could not scan selected media' : 'No meal plan yet',
          error instanceof Error ? error.message : 'Please try again in a moment.',
        );
      }
    } finally {
      if (activeRequestController.current === controller) {
        activeRequestController.current = null;
        requestInFlight.current = false;
        setCancelling(false);
        setScanning(false);
        setPlanning(false);
        setRegenerating(false);
      }
    }
  }

  async function saveCurrentRecipe() {
    const recipe = plan?.recipe;
    if (!recipe) {
      return;
    }
    const imageAtSave = recipeImage;
    setSavingRecipe(true);
    try {
      const saved = await saveRecipe(
        recipe,
        recipe.cuisine ?? cuisine,
        planGeneratedAt ?? new Date().toISOString(),
        imageAtSave,
      );
      syncSavedRecipes(saved);
      const savedEntry = saved[0];
      if (imageAtSave === undefined && savedEntry?.image === undefined) {
        void getRecipeImage(recipe.title)
          .then(async (image) => {
            const updated = await updateRecipeImage(savedEntry.savedAt, image);
            syncSavedRecipes(updated);
            setSelectedSavedRecipe((current) =>
              current?.savedAt === savedEntry.savedAt
                ? (updated.find((entry) => entry.savedAt === savedEntry.savedAt) ?? null)
                : current,
            );
          })
          .catch(() => undefined);
      }
    } catch {
      Alert.alert(
        'Could not save that recipe',
        'Please check that this device has storage available.',
      );
    } finally {
      setSavingRecipe(false);
    }
  }

  async function findNearbyStores() {
    const targetPlan = plan;
    if (!targetPlan?.missing_ingredients.length || storeRequestController.current) {
      return;
    }

    const controller = new AbortController();
    storeRequestController.current = controller;
    setLoadingStores(true);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) {
        if (!permission.canAskAgain) {
          Alert.alert(
            'Location permission is blocked',
            "Nearby grocery offers are off because location access was blocked for PantryPilot. Enable Location in this app's system settings, then try again.",
            [
              { text: 'Not now', style: 'cancel' },
              { text: 'Open Settings', onPress: openAppSettings },
            ],
          );
          return;
        }
        Alert.alert(
          'Location permission was not granted',
          'Allow location access to find grocery offers near you. You can still use the recipe without them.',
        );
        return;
      }
      if (controller.signal.aborted) {
        return;
      }
      const locationServicesEnabled = await Location.hasServicesEnabledAsync();
      if (!locationServicesEnabled) {
        Alert.alert(
          'Turn on device location',
          'PantryPilot has permission, but your device location services are off. Turn on Location in your device settings, then try again.',
        );
        return;
      }
      const position = await getCurrentPosition(controller.signal);
      if (controller.signal.aborted) {
        return;
      }
      const response = await requestStores(
        {
          items: targetPlan.missing_ingredients,
          location: {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
          },
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) {
        return;
      }
      setPlan((current) =>
        current === targetPlan
          ? {
              ...current,
              stores: response.stores,
              shopping_notice: response.shopping_notice,
            }
          : current,
      );
    } catch (error) {
      if (!controller.signal.aborted) {
        Alert.alert(
          'Could not find grocery offers',
          error instanceof Error ? error.message : 'Please try again in a moment.',
        );
      }
    } finally {
      if (storeRequestController.current === controller) {
        storeRequestController.current = null;
        setLoadingStores(false);
        setCancelling(false);
      }
    }
  }

  function closeGeneratedRecipe() {
    abortActiveRequest();
    setRecipeOpen(false);
  }

  function syncSavedRecipes(recipes: SavedRecipe[]) {
    setSavedRecipes(recipes);
    setSavedTitles(recipes.map((entry) => entry.recipe.title));
  }

  function openSavedRecipe(entry: SavedRecipe) {
    setSavedRecipesOpen(false);
    setSelectedSavedRecipe(entry);
  }

  function confirmDeleteSavedRecipe(entry: SavedRecipe) {
    Alert.alert('Delete saved recipe?', `Remove “${entry.recipe.title}” from your saved recipes?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          void removeSavedRecipe(entry);
        },
      },
    ]);
  }

  async function removeSavedRecipe(entry: SavedRecipe) {
    try {
      const saved = await deleteSavedRecipe(entry.savedAt);
      syncSavedRecipes(saved);
      if (selectedSavedRecipe?.savedAt === entry.savedAt) {
        setSelectedSavedRecipe(null);
      }
    } catch {
      Alert.alert(
        'Could not delete that recipe',
        'Please check that this device has storage available.',
      );
    }
  }

  async function saveRecipeNotes(entry: SavedRecipe, notes: string) {
    try {
      const saved = await updateRecipeNotes(entry.savedAt, notes);
      syncSavedRecipes(saved);
      setSelectedSavedRecipe(saved.find((item) => item.savedAt === entry.savedAt) ?? null);
    } catch {
      Alert.alert('Could not save notes', 'Please check that this device has storage available.');
    }
  }

  async function saveSavedRecipeImage(entry: SavedRecipe, image: RecipeImage | null) {
    if (entry.image === image) {
      return;
    }
    try {
      const saved = await updateRecipeImage(entry.savedAt, image);
      syncSavedRecipes(saved);
      setSelectedSavedRecipe(saved.find((item) => item.savedAt === entry.savedAt) ?? null);
    } catch {
      // The preview is optional; a storage problem should not interrupt reading.
    }
  }

  const ingredientSummary = useMemo(() => {
    if (!ingredients.length) {
      return 'No inventory yet';
    }
    if (!expiringCount) {
      return `${ingredients.length} items reviewed`;
    }
    return `${ingredients.length} items · ${expiringCount} use soon`;
  }, [ingredients.length, expiringCount]);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safeArea}>
        <StatusBar barStyle="dark-content" />
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={[styles.scrollContent, { alignItems: 'center' }]}
          showsVerticalScrollIndicator={false}
        >
          <View style={[styles.content, { width: contentWidth }]}>
            <View style={styles.header}>
              {activePage === 'pantry' ? (
                <Pressable
                  accessibilityLabel="Back to food style"
                  disabled={isProcessing}
                  hitSlop={8}
                  onPress={() => navigateToPage('mood')}
                  style={[styles.pageBack, isProcessing && styles.disabledMediaAction]}
                >
                  <Ionicons color={colors.moss} name="arrow-back" size={19} />
                  <Text style={styles.pageBackText}>Food Style</Text>
                </Pressable>
              ) : (
                <View style={styles.brandRow}>
                  <View style={styles.mark}>
                    <Image
                      accessibilityLabel="PantryPilot"
                      source={require('./assets/icon.png')}
                      style={styles.markImage}
                    />
                  </View>
                  <Text style={styles.brand}>PantryPilot</Text>
                </View>
              )}
              <Pressable
                accessibilityLabel="Open saved recipes"
                hitSlop={10}
                style={styles.infoButton}
                onPress={() => setSavedRecipesOpen(true)}
              >
                <Ionicons name="menu" color={colors.moss} size={23} />
              </Pressable>
            </View>

            <Animated.View
              {...pagePanResponder.panHandlers}
              style={{ transform: [{ translateX: pageSlide }] }}
            >
              {activePage === 'mood' ? (
                <>
                  <View style={styles.intro}>
                    <Text style={styles.kicker}>
                      {makeToday ? 'MAKE TODAY COUNT' : 'MAKE TONIGHT COUNT'}
                    </Text>
                    <Text style={styles.title}>
                      {`Less guesswork.\n${makeToday ? 'More lunch.' : 'More dinner.'}`}
                    </Text>
                    <Text style={styles.lede}>
                      A quick scan turns what you already have into a recipe worth making.
                    </Text>
                  </View>

                  <View style={[styles.card, styles.cuisineCard]}>
                    <View style={styles.cardHeading}>
                      <View>
                        <Text style={styles.sectionTitle}>Choose a cuisine</Text>
                      </View>
                      <View style={styles.smallIcon}>
                        <Ionicons name="restaurant-outline" color={colors.moss} size={19} />
                      </View>
                    </View>
                    <Pressable
                      disabled={isProcessing}
                      onPress={() => setCuisinePickerOpen(true)}
                      style={[styles.cuisinePicker, isProcessing && styles.disabledMediaAction]}
                    >
                      <View>
                        <Text style={styles.cuisineName}>{cuisine}</Text>
                        <Text style={styles.cuisineMeta}>{cuisineSubtitle}</Text>
                      </View>
                      <Ionicons name="chevron-down" color={colors.moss} size={20} />
                    </Pressable>
                    <View style={styles.preferenceBlock}>
                      <Text style={styles.preferenceLabel}>DIETARY RESTRICTIONS</Text>
                      <View style={styles.dietChoices}>
                        {DIETARY_OPTIONS.map((option) => (
                          <DietChoice
                            disabled={isProcessing}
                            key={option.value}
                            icon={option.icon}
                            label={option.label}
                            selected={dietary.diet === option.value}
                            onPress={() => {
                              setDietary((current) => ({
                                ...current,
                                diet: current.diet === option.value ? 'none' : option.value,
                              }));
                              setPlan(null);
                            }}
                          />
                        ))}
                      </View>
                      <View style={styles.checkboxChoices}>
                        <PreferenceCheckbox
                          disabled={isProcessing}
                          label="Gluten-free"
                          selected={dietary.gluten_free}
                          onPress={() => {
                            setDietary((current) => ({
                              ...current,
                              gluten_free: !current.gluten_free,
                            }));
                            setPlan(null);
                          }}
                        />
                        <PreferenceCheckbox
                          disabled={isProcessing}
                          label="Oven available"
                          selected={dietary.oven_available}
                          onPress={() => {
                            setDietary((current) => ({
                              ...current,
                              oven_available: !current.oven_available,
                            }));
                            setPlan(null);
                          }}
                        />
                      </View>
                    </View>
                    <View style={styles.tasteProfileBlock}>
                      <View style={styles.tasteProfileHeader}>
                        <Text style={styles.sectionTitle}>Taste Profile</Text>
                      </View>
                      <Text style={styles.tasteProfileExamples}>
                        “I want something sweet/savory/sour/spicy”{`\n`}“Something hearty for a cold
                        day”{`\n`}“Pairs well with Pinot Noir”
                      </Text>
                      <TextInput
                        editable={!isProcessing}
                        multiline
                        onChangeText={(value) => {
                          setTasteProfile(limitTasteProfile(value));
                          setPlan(null);
                        }}
                        placeholder="What sounds good today?"
                        placeholderTextColor="#8B948C"
                        style={styles.tasteProfileInput}
                        textAlignVertical="top"
                        value={tasteProfile}
                      />
                      <Text style={styles.tasteProfileCount}>
                        {tasteProfile.trim()
                          ? `${tasteProfile.trim().split(/\s+/).filter(Boolean).length}/${TASTE_PROFILE_WORD_LIMIT} words`
                          : `0/${TASTE_PROFILE_WORD_LIMIT} words`}
                      </Text>
                    </View>
                  </View>

                  <Pressable
                    accessibilityLabel="Continue to scan pantry"
                    disabled={isProcessing}
                    onPress={() => navigateToPage('pantry')}
                    style={[styles.nextPageButton, isProcessing && styles.disabledMediaAction]}
                  >
                    <Text style={styles.nextPageButtonText}>Next: scan your kitchen</Text>
                    <Ionicons color="#FFFFFF" name="arrow-forward" size={18} />
                  </Pressable>
                </>
              ) : null}

              {activePage === 'pantry' ? (
                <>
                  <View style={styles.pantryIntro}>
                    <Text style={styles.pageTitle}>Scan your kitchen.</Text>
                    <Text style={styles.pageLede}>
                      Add what you have, then let PantryPilot make it count.
                    </Text>
                  </View>
                  <View style={[styles.scanCard, shadow]}>
                    <View style={styles.scanArtwork}>
                      <View style={styles.shelfTop}>
                        <View style={styles.jar} />
                        <View style={styles.bottle} />
                        <View style={styles.jarSmall} />
                      </View>
                      <View style={styles.shelfLine} />
                      <View style={styles.shelfBottom}>
                        <View style={styles.orange} />
                        <View style={styles.leafy} />
                        <View style={styles.orangeSmall} />
                      </View>
                    </View>
                    <Text style={styles.scanTitle}>What’s in the kitchen?</Text>
                    <Text style={styles.scanCopy}>
                      Use one short walkthrough or up to four photos.
                    </Text>
                    <View style={styles.scanActions}>
                      <Pressable
                        disabled={mediaControlsLocked}
                        onPress={() => selectVideo('camera')}
                        style={[styles.primaryButton, mediaControlsLocked && styles.disabledButton]}
                      >
                        {scanning ? (
                          <ActivityIndicator color="#FFFFFF" />
                        ) : (
                          <Ionicons name="videocam" color="#FFFFFF" size={19} />
                        )}
                        <Text style={styles.primaryButtonText}>
                          {scanning ? 'Checking your shelves…' : 'Record a video'}
                        </Text>
                      </Pressable>
                      <Pressable
                        disabled={mediaControlsLocked}
                        onPress={() => selectVideo('library')}
                        style={[
                          styles.secondaryButton,
                          mediaControlsLocked && styles.disabledButton,
                        ]}
                      >
                        <Ionicons name="videocam-outline" color="#F2F8F1" size={19} />
                        <Text style={styles.secondaryButtonText}>Choose one video</Text>
                      </Pressable>
                      <Pressable
                        disabled={mediaControlsLocked}
                        onPress={selectPhotos}
                        style={[
                          styles.secondaryButton,
                          mediaControlsLocked && styles.disabledButton,
                        ]}
                      >
                        {preparingPhotos ? (
                          <ActivityIndicator color="#F2F8F1" />
                        ) : (
                          <Ionicons name="images-outline" color="#F2F8F1" size={19} />
                        )}
                        <Text style={styles.secondaryButtonText}>
                          {preparingPhotos ? 'Preparing photos...' : 'Choose up to 4 photos'}
                        </Text>
                      </Pressable>
                    </View>
                    {pendingScan ? (
                      <PendingScanList
                        disabled={mediaControlsLocked}
                        pendingScan={pendingScan}
                        onRemove={removePendingMedia}
                        onClear={clearPendingScan}
                      />
                    ) : null}
                  </View>

                  <View style={styles.inventoryHeader}>
                    <View>
                      <Text style={[styles.sectionTitle, styles.inventoryTitle]}>
                        Your inventory
                      </Text>
                      <Text style={[styles.eyebrow, styles.inventoryLabel]}>CURRENTLY ON HAND</Text>
                    </View>
                    <Text style={styles.itemCount}>{ingredientSummary}</Text>
                  </View>
                  <View style={[styles.card, styles.inventoryCard]}>
                    {!ingredients.length ? (
                      <Text style={styles.emptyText}>
                        Start by adding items yourself, or scan your kitchen to fill this in.
                      </Text>
                    ) : null}
                    <View style={styles.chipWrap}>
                      {ingredients.map((ingredient, index) => (
                        <IngredientChip
                          disabled={mediaControlsLocked}
                          ingredient={ingredient}
                          key={`${ingredient.normalized_name}-${index}`}
                          onPress={() => openIngredientEditor(index)}
                        />
                      ))}
                      <Pressable
                        disabled={mediaControlsLocked}
                        onPress={() => openIngredientEditor()}
                        style={[styles.addChip, mediaControlsLocked && styles.disabledMediaAction]}
                      >
                        <Ionicons name="add" color={colors.moss} size={16} />
                        <Text style={styles.addChipText}>Add item</Text>
                      </Pressable>
                    </View>
                    {scanNotice ? (
                      <View style={styles.notice}>
                        <Ionicons name="sparkles" color={colors.moss} size={15} />
                        <Text style={styles.noticeText}>{scanNotice}</Text>
                      </View>
                    ) : null}
                  </View>

                  <View style={styles.stapleBlock}>
                    <Text style={styles.eyebrow}>ALWAYS ON HAND (OR NOT)</Text>
                    <View style={styles.stapleRow}>
                      {DEFAULT_STAPLES.map((staple) => {
                        const active = staples.includes(staple);
                        return (
                          <Pressable
                            disabled={isProcessing}
                            key={staple}
                            onPress={() => toggleStaple(staple)}
                            style={[
                              styles.staple,
                              active && styles.stapleActive,
                              isProcessing && styles.disabledMediaAction,
                            ]}
                          >
                            <Ionicons
                              name={active ? 'checkmark-circle' : 'ellipse-outline'}
                              color={active ? colors.moss : colors.muted}
                              size={16}
                            />
                            <Text style={[styles.stapleText, active && styles.stapleTextActive]}>
                              {titleCase(staple)}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>

                  <Pressable
                    disabled={!canOpenOrCreatePlan}
                    onPress={() => {
                      if (plan) {
                        setRecipeOpen(true);
                      } else {
                        void getPlan();
                      }
                    }}
                    style={[styles.planButton, !canOpenOrCreatePlan && styles.planButtonDisabled]}
                  >
                    {isProcessing ? (
                      <ActivityIndicator color={colors.ink} />
                    ) : (
                      <>
                        <Text style={styles.planButtonText}>
                          {plan
                            ? 'View current dish'
                            : pendingScan
                              ? 'Scan & find my dish'
                              : 'Find my dish'}
                        </Text>
                        <Ionicons name="arrow-forward" color={colors.ink} size={20} />
                      </>
                    )}
                  </Pressable>
                  {plan ? (
                    <Pressable
                      accessibilityLabel="Generate another dish"
                      disabled={isProcessing}
                      onPress={() => {
                        void getPlan(true);
                      }}
                      style={[
                        styles.pantryTryAnotherButton,
                        isProcessing && styles.disabledMediaAction,
                      ]}
                    >
                      <Ionicons name="shuffle" color={colors.moss} size={18} />
                      <Text style={styles.pantryTryAnotherText}>Try another dish</Text>
                    </Pressable>
                  ) : null}
                  {isProcessing ? (
                    <Pressable
                      accessibilityLabel="Abort current request"
                      disabled={cancelling}
                      onPress={abortActiveRequest}
                      style={[styles.abortButton, cancelling && styles.abortButtonDisabled]}
                    >
                      <Ionicons name="close-circle-outline" color={colors.moss} size={18} />
                      <Text style={styles.abortButtonText}>
                        {cancelling
                          ? 'Cancelling request…'
                          : preparingPhotos
                            ? 'Cancel photo preparation'
                            : 'Abort request'}
                      </Text>
                    </Pressable>
                  ) : null}
                </>
              ) : null}
            </Animated.View>
          </View>
        </ScrollView>

        <Modal
          animationType="slide"
          transparent
          visible={cuisinePickerOpen}
          onRequestClose={() => setCuisinePickerOpen(false)}
        >
          <Pressable style={styles.modalBackdrop} onPress={() => setCuisinePickerOpen(false)}>
            <Pressable
              style={[styles.sheet, { width: Math.min(width - 24, 680) }]}
              onPress={() => undefined}
            >
              <View style={styles.sheetHandle} />
              <Text style={styles.sheetTitle}>Pick a cuisine</Text>
              <Text style={styles.sheetCopy}>
                Surprise Me picks one cuisine at random and still respects your dietary choices.
              </Text>
              <View style={styles.cuisinePreferenceSummary}>
                <Ionicons name="options-outline" color={colors.moss} size={15} />
                <Text style={styles.cuisinePreferenceText}>
                  {preferenceSummary || 'No dietary preference selected'}
                </Text>
              </View>
              <View style={styles.cuisineGrid}>
                {CUISINES.map((item) => (
                  <Pressable
                    disabled={isProcessing}
                    key={item}
                    onPress={() => {
                      setCuisine(item);
                      setCuisinePickerOpen(false);
                      setPlan(null);
                    }}
                    style={[
                      styles.cuisineOption,
                      cuisine === item && styles.cuisineOptionSelected,
                      isProcessing && styles.disabledMediaAction,
                    ]}
                  >
                    <Text
                      style={[
                        styles.cuisineOptionText,
                        cuisine === item && styles.cuisineOptionTextSelected,
                      ]}
                    >
                      {item}
                    </Text>
                    {cuisine === item ? (
                      <Ionicons name="checkmark" color="#FFFFFF" size={16} />
                    ) : null}
                  </Pressable>
                ))}
              </View>
            </Pressable>
          </Pressable>
        </Modal>

        <Modal
          animationType="fade"
          transparent
          visible={addIngredientOpen}
          onRequestClose={closeIngredientEditor}
        >
          <View style={styles.modalBackdrop}>
            <View style={[styles.addDialog, { width: Math.min(width - 40, 420) }]}>
              <Text style={styles.sheetTitle}>
                {editingIngredientIndex === null ? 'Add an ingredient' : 'Edit ingredient'}
              </Text>
              <Text style={styles.sheetCopy}>
                {editingIngredientIndex === null
                  ? 'Build your inventory manually, with an optional quantity.'
                  : 'Update the item or its quantity, or remove it from your inventory.'}
              </Text>
              <Text style={styles.inputLabel}>ITEM</Text>
              <TextInput
                autoFocus
                autoCapitalize="words"
                value={draftIngredient}
                onChangeText={setDraftIngredient}
                placeholder="e.g. Chickpeas"
                placeholderTextColor="#8B948C"
                style={styles.input}
              />
              <Text style={styles.inputLabel}>QUANTITY (OPTIONAL)</Text>
              <TextInput
                autoCapitalize="sentences"
                value={draftQuantity}
                onChangeText={setDraftQuantity}
                onSubmitEditing={saveIngredient}
                placeholder="e.g. 1 can, 2 cups, half a bag"
                placeholderTextColor="#8B948C"
                style={styles.inputCompact}
              />
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: draftExpiresSoon }}
                onPress={() => setDraftExpiresSoon((current) => !current)}
                style={[
                  styles.expiresSoonOption,
                  draftExpiresSoon && styles.expiresSoonOptionSelected,
                ]}
              >
                <View
                  style={[
                    styles.expiresSoonMark,
                    draftExpiresSoon && styles.expiresSoonMarkSelected,
                  ]}
                >
                  {draftExpiresSoon ? (
                    <Ionicons color="#FFFFFF" name="checkmark" size={14} />
                  ) : null}
                </View>
                <View style={styles.expiresSoonCopy}>
                  <Text style={styles.expiresSoonTitle}>Use Soon</Text>
                  <Text style={styles.expiresSoonHint}>
                    Highlight this item in your use-soon list
                  </Text>
                </View>
              </Pressable>
              <View style={styles.dialogActions}>
                {editingIngredientIndex !== null ? (
                  <Pressable onPress={removeEditingIngredient} style={styles.dialogRemove}>
                    <Ionicons name="trash-outline" color={colors.red} size={15} />
                    <Text style={styles.dialogRemoveText}>Remove</Text>
                  </Pressable>
                ) : null}
                <Pressable onPress={closeIngredientEditor} style={styles.dialogCancel}>
                  <Text style={styles.dialogCancelText}>Cancel</Text>
                </Pressable>
                <Pressable onPress={saveIngredient} style={styles.dialogConfirm}>
                  <Text style={styles.dialogConfirmText}>
                    {editingIngredientIndex === null ? 'Add item' : 'Save changes'}
                  </Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>

        <Modal
          animationType="fade"
          transparent
          visible={savedRecipesOpen}
          onRequestClose={() => setSavedRecipesOpen(false)}
        >
          <View style={styles.sidebarOverlay}>
            <Pressable
              accessibilityLabel="Close saved recipes"
              onPress={() => setSavedRecipesOpen(false)}
              style={styles.sidebarDismiss}
            />
            <View style={[styles.sidebar, { width: Math.min(width * 0.88, 370) }]}>
              <View style={styles.sidebarHeader}>
                <View>
                  <Text style={styles.sidebarEyebrow}>YOUR LIBRARY</Text>
                  <Text style={styles.sidebarTitle}>Saved recipes</Text>
                </View>
                <Pressable
                  accessibilityLabel="Close saved recipes"
                  hitSlop={10}
                  onPress={() => setSavedRecipesOpen(false)}
                  style={styles.sidebarClose}
                >
                  <Ionicons color={colors.moss} name="close" size={20} />
                </Pressable>
              </View>
              {savedRecipes.length ? (
                <ScrollView
                  contentContainerStyle={styles.sidebarList}
                  showsVerticalScrollIndicator={false}
                >
                  {savedRecipes.map((entry) => (
                    <View key={entry.savedAt} style={styles.sidebarRecipeRow}>
                      <Pressable
                        accessibilityLabel={`Open ${entry.recipe.title}`}
                        onPress={() => openSavedRecipe(entry)}
                        style={styles.sidebarRecipeOpen}
                      >
                        <View style={styles.sidebarRecipeIcon}>
                          <Ionicons color={colors.moss} name="restaurant-outline" size={17} />
                        </View>
                        <View style={styles.sidebarRecipeCopy}>
                          <Text numberOfLines={1} style={styles.sidebarRecipeTitle}>
                            {entry.recipe.title}
                          </Text>
                          <Text style={styles.sidebarRecipeMeta}>
                            {entry.recipe.cuisine ?? entry.cuisine} ·{' '}
                            {formatGeneratedDate(entry.generatedAt)}
                          </Text>
                        </View>
                        <Ionicons color={colors.muted} name="chevron-forward" size={18} />
                      </Pressable>
                      <Pressable
                        accessibilityLabel={`Delete ${entry.recipe.title}`}
                        hitSlop={8}
                        onPress={() => confirmDeleteSavedRecipe(entry)}
                        style={styles.sidebarDelete}
                      >
                        <Ionicons color={colors.red} name="trash-outline" size={17} />
                      </Pressable>
                    </View>
                  ))}
                </ScrollView>
              ) : (
                <View style={styles.sidebarEmpty}>
                  <Ionicons color={colors.muted} name="bookmark-outline" size={31} />
                  <Text style={styles.sidebarEmptyTitle}>Nothing saved yet</Text>
                  <Text style={styles.sidebarEmptyCopy}>
                    Save a dish to keep its recipe and your notes here.
                  </Text>
                </View>
              )}
            </View>
          </View>
        </Modal>

        <Modal
          animationType="slide"
          visible={Boolean(selectedSavedRecipe)}
          onRequestClose={() => setSelectedSavedRecipe(null)}
        >
          <SafeAreaView style={styles.detailSafeArea}>
            <KeyboardAvoidingView
              behavior={Platform.OS === 'ios' ? 'padding' : undefined}
              style={styles.detailKeyboardAvoiding}
            >
              {selectedSavedRecipe ? (
                <SavedRecipeDetail
                  key={selectedSavedRecipe.savedAt}
                  entry={selectedSavedRecipe}
                  onBack={() => setSelectedSavedRecipe(null)}
                  onDelete={() => confirmDeleteSavedRecipe(selectedSavedRecipe)}
                  onSaveImage={saveSavedRecipeImage}
                  onSaveNotes={saveRecipeNotes}
                />
              ) : null}
            </KeyboardAvoidingView>
          </SafeAreaView>
        </Modal>

        <Modal
          animationType="slide"
          presentationStyle="fullScreen"
          visible={recipeOpen && Boolean(plan)}
          onRequestClose={closeGeneratedRecipe}
        >
          <SafeAreaView style={styles.detailSafeArea}>
            {recipeOpen && plan ? (
              <GeneratedRecipeDetail
                image={recipeImage}
                loading={regenerating}
                loadingStores={loadingStores}
                onBack={closeGeneratedRecipe}
                onRecipeImage={setRecipeImage}
                onRequestLocation={() => {
                  void findNearbyStores();
                }}
                onSave={saveCurrentRecipe}
                onTryAnother={() => {
                  void getPlan(true);
                }}
                plan={plan}
                saved={Boolean(plan.recipe && savedTitles.includes(plan.recipe.title))}
                saving={savingRecipe}
              />
            ) : null}
          </SafeAreaView>
        </Modal>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function PendingScanList({
  pendingScan,
  onRemove,
  onClear,
  disabled,
}: {
  pendingScan: PendingScan;
  onRemove: (id: string) => void;
  onClear: () => void;
  disabled: boolean;
}) {
  return (
    <View style={styles.selectedMedia}>
      <View style={styles.selectedMediaHeader}>
        <Text style={styles.selectedMediaTitle}>
          {pendingScan.kind === 'video'
            ? '1 VIDEO READY'
            : `${pendingScan.items.length} PHOTO${pendingScan.items.length === 1 ? '' : 'S'} READY`}
        </Text>
        <Pressable
          accessibilityLabel="Clear selected media"
          disabled={disabled}
          onPress={onClear}
          style={disabled && styles.disabledMediaAction}
        >
          <Text style={styles.clearMediaText}>Clear</Text>
        </Pressable>
      </View>
      {pendingScan.items.map((item) => (
        <View key={item.id} style={styles.selectedMediaRow}>
          {pendingScan.kind === 'images' ? (
            <Image source={{ uri: item.uri }} style={styles.selectedPhoto} />
          ) : (
            <View style={styles.selectedVideo}>
              <Ionicons name="videocam" color="#F2F8F1" size={17} />
            </View>
          )}
          <Text numberOfLines={1} style={styles.selectedMediaName}>
            {item.label}
          </Text>
          <Pressable
            accessibilityLabel={`Remove ${item.label}`}
            disabled={disabled}
            hitSlop={8}
            onPress={() => onRemove(item.id)}
            style={[styles.removeMediaButton, disabled && styles.disabledMediaAction]}
          >
            <Ionicons name="trash-outline" color="#FFFFFF" size={17} />
          </Pressable>
        </View>
      ))}
    </View>
  );
}

function DietChoice({
  disabled,
  icon,
  label,
  onPress,
  selected,
}: {
  disabled: boolean;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  selected: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.dietChoice,
        selected && styles.dietChoiceSelected,
        disabled && styles.disabledMediaAction,
      ]}
    >
      <Ionicons color={selected ? '#FFFFFF' : colors.moss} name={icon} size={15} />
      <Text style={[styles.dietChoiceText, selected && styles.dietChoiceTextSelected]}>
        {label}
      </Text>
      {selected ? <Ionicons color="#FFFFFF" name="checkmark" size={14} /> : null}
    </Pressable>
  );
}

function PreferenceCheckbox({
  disabled,
  label,
  onPress,
  selected,
}: {
  disabled: boolean;
  label: string;
  onPress: () => void;
  selected: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.preferenceCheckbox,
        selected && styles.preferenceCheckboxSelected,
        disabled && styles.disabledMediaAction,
      ]}
    >
      <View style={[styles.checkboxMark, selected && styles.checkboxMarkSelected]}>
        {selected ? <Ionicons color="#FFFFFF" name="checkmark" size={14} /> : null}
      </View>
      <Text style={styles.preferenceCheckboxText}>{label}</Text>
    </Pressable>
  );
}

function PlanPanel({
  plan,
  onTryAnother,
  loading,
  loadingStores,
  onRequestLocation,
  onSave,
  saved,
  saving,
  image,
  onRecipeImage,
  fullPage = false,
}: {
  plan: PlanResponse;
  onTryAnother: () => void;
  loading: boolean;
  loadingStores: boolean;
  onRequestLocation: () => void;
  onSave: () => void;
  saved: boolean;
  saving: boolean;
  image?: RecipeImage | null;
  onRecipeImage: (image: RecipeImage | null) => void;
  fullPage?: boolean;
}) {
  const recipe = plan.recipe;
  const actionsLocked = loading || loadingStores;
  return (
    <View style={[styles.resultWrap, fullPage && styles.resultWrapFull]}>
      <View style={styles.resultHeader}>
        <Text style={styles.eyebrow}>YOUR DINNER IDEA</Text>
        {plan.demo_mode ? <Text style={styles.demoPill}>DEMO</Text> : null}
      </View>
      <View style={[styles.resultCard, shadow]}>
        {plan.status === 'no_feasible_recipe' ? (
          <View style={styles.noPlanIcon}>
            <Ionicons name="compass-outline" color={colors.moss} size={25} />
          </View>
        ) : (
          <View style={styles.recipeFlag}>
            <Ionicons name="sparkles" color={colors.limeInk} size={15} />
            <Text style={styles.recipeFlagText}>
              {plan.status === 'needs_shopping' ? 'ONE SMALL SHOP AWAY' : 'MADE FROM YOUR SHELVES'}
            </Text>
          </View>
        )}
        {recipe ? (
          <>
            <Text style={styles.recipeTitle}>{recipe.title}</Text>
            {recipe.cuisine ? (
              <View style={styles.recipeCuisine}>
                <Ionicons name="globe-outline" color={colors.moss} size={13} />
                <Text style={styles.recipeCuisineText}>{recipe.cuisine}</Text>
              </View>
            ) : null}
            <Text style={styles.recipeDescription}>{recipe.description}</Text>
            <DietaryMarks
              glutenFree={recipe.is_gluten_free}
              ketoFriendly={recipe.is_keto_friendly ?? false}
              vegan={recipe.is_vegan}
              vegetarian={recipe.is_vegetarian ?? false}
            />
            <RecipeDishImage image={image} onImageResolved={onRecipeImage} title={recipe.title} />
            <RecipeFacts recipe={recipe} />
          </>
        ) : null}
        {plan.status === 'needs_shopping' ? (
          <ShoppingBlock
            loading={loadingStores}
            plan={plan}
            onRequestLocation={onRequestLocation}
          />
        ) : null}
        {plan.status !== 'no_feasible_recipe' && recipe ? (
          <>
            <Text style={styles.recipeSubheading}>Method</Text>
            {recipe.steps.map((step) => (
              <View key={step.order} style={styles.step}>
                <Text style={styles.stepNumber}>{step.order}</Text>
                <Text style={styles.stepText}>{step.text}</Text>
              </View>
            ))}
            <FastPerishingGauge value={recipe.fast_perishing_utilization} />
            {recipe.storage_tip ? (
              <Text style={styles.storageText}>Storage: {recipe.storage_tip}</Text>
            ) : null}
          </>
        ) : null}
        {plan.status !== 'no_feasible_recipe' && recipe ? (
          <Pressable
            disabled={saved || saving || actionsLocked}
            onPress={onSave}
            style={[
              styles.saveButton,
              (saved || saving) && styles.saveButtonSaved,
              actionsLocked && styles.disabledMediaAction,
            ]}
          >
            {saving ? (
              <ActivityIndicator color="#FFFFFF" size="small" />
            ) : (
              <Ionicons
                name={saved ? 'bookmark' : 'bookmark-outline'}
                color={saved ? '#FFFFFF' : colors.moss}
                size={17}
              />
            )}
            <Text style={[styles.saveText, (saved || saving) && styles.saveTextSaved]}>
              {saved ? 'Saved on this device' : saving ? 'Saving recipe…' : 'Save recipe'}
            </Text>
          </Pressable>
        ) : null}
        <Pressable
          disabled={actionsLocked}
          onPress={onTryAnother}
          style={[styles.againButton, actionsLocked && styles.disabledMediaAction]}
        >
          {loading ? (
            <ActivityIndicator color={colors.moss} />
          ) : (
            <>
              <Ionicons name="shuffle" color={colors.moss} size={17} />
              <Text style={styles.againText}>
                {plan.status === 'no_feasible_recipe' ? 'Check again' : 'Try another dish'}
              </Text>
            </>
          )}
        </Pressable>
      </View>
    </View>
  );
}

function GeneratedRecipeDetail({
  plan,
  onBack,
  onRequestLocation,
  onSave,
  onTryAnother,
  loading,
  loadingStores,
  saved,
  saving,
  image,
  onRecipeImage,
}: {
  plan: PlanResponse;
  onBack: () => void;
  onRequestLocation: () => void;
  onSave: () => void;
  onTryAnother: () => void;
  loading: boolean;
  loadingStores: boolean;
  saved: boolean;
  saving: boolean;
  image?: RecipeImage | null;
  onRecipeImage: (image: RecipeImage | null) => void;
}) {
  const title =
    new Date().getHours() >= 6 && new Date().getHours() < 18
      ? 'Today’s Recipe'
      : 'Tonight’s Recipe';
  return (
    <ScrollView
      contentContainerStyle={[styles.detailContent, styles.generatedDetailContent]}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.detailHeader}>
        <Pressable
          accessibilityLabel="Back to pantry"
          hitSlop={10}
          onPress={onBack}
          style={styles.detailBack}
        >
          <Ionicons color={colors.moss} name="arrow-back" size={21} />
        </Pressable>
        <Text style={styles.detailHeaderTitle}>{title}</Text>
        <View style={styles.detailHeaderSpacer} />
      </View>
      <PlanPanel
        fullPage
        image={image}
        loading={loading}
        loadingStores={loadingStores}
        onRecipeImage={onRecipeImage}
        onRequestLocation={onRequestLocation}
        onSave={onSave}
        onTryAnother={onTryAnother}
        plan={plan}
        saved={saved}
        saving={saving}
      />
    </ScrollView>
  );
}

function RecipeFacts({
  recipe,
  calorieIcon = 'heart-outline',
}: {
  recipe: NonNullable<PlanResponse['recipe']>;
  calorieIcon?: keyof typeof Ionicons.glyphMap;
}) {
  const hasTiming = recipe.prep_minutes + recipe.cook_minutes > 0;
  const hasCalories = typeof recipe.calories_per_serving === 'number';
  if (!hasTiming && !hasCalories) {
    return null;
  }
  return (
    <View style={styles.recipeFacts}>
      {hasTiming ? (
        <>
          <View style={styles.recipeFact}>
            <Ionicons color={colors.moss} name="time-outline" size={15} />
            <View>
              <Text style={styles.recipeFactValue}>{recipe.prep_minutes} min</Text>
              <Text style={styles.recipeFactLabel}>Prep</Text>
            </View>
          </View>
          <View style={styles.recipeFact}>
            <Ionicons color={colors.moss} name="flame-outline" size={15} />
            <View>
              <Text style={styles.recipeFactValue}>{recipe.cook_minutes} min</Text>
              <Text style={styles.recipeFactLabel}>Cook</Text>
            </View>
          </View>
        </>
      ) : null}
      {hasCalories ? (
        <View style={styles.recipeFact}>
          <Ionicons color={colors.moss} name={calorieIcon} size={15} />
          <View>
            <Text style={styles.recipeFactValue}>~{recipe.calories_per_serving} kcal</Text>
            <Text style={styles.recipeFactLabel}>Per serving</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function formatGeneratedDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Date unavailable';
  }
  return `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })} · ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

function limitRecipeNotes(value: string) {
  const characterLimited = value.slice(0, NOTE_CHARACTER_LIMIT);
  const words = characterLimited.trim().split(/\s+/).filter(Boolean);
  return words.length <= NOTE_WORD_LIMIT
    ? characterLimited
    : words.slice(0, NOTE_WORD_LIMIT).join(' ');
}

function limitTasteProfile(value: string) {
  const characterLimited = value.slice(0, TASTE_PROFILE_CHARACTER_LIMIT);
  const words = characterLimited.trim().split(/\s+/).filter(Boolean);
  return words.length <= TASTE_PROFILE_WORD_LIMIT
    ? characterLimited
    : words.slice(0, TASTE_PROFILE_WORD_LIMIT).join(' ');
}

function SavedRecipeDetail({
  entry,
  onBack,
  onDelete,
  onSaveNotes,
  onSaveImage,
}: {
  entry: SavedRecipe;
  onBack: () => void;
  onDelete: () => void;
  onSaveNotes: (entry: SavedRecipe, notes: string) => Promise<void>;
  onSaveImage: (entry: SavedRecipe, image: RecipeImage | null) => Promise<void>;
}) {
  const [notes, setNotes] = useState(entry.notes);
  const [savingNotes, setSavingNotes] = useState(false);
  const scrollViewRef = useRef<ScrollView>(null);
  const noteWords = notes.trim().split(/\s+/).filter(Boolean).length;

  async function saveNotes() {
    setSavingNotes(true);
    try {
      await onSaveNotes(entry, notes.trim());
    } finally {
      setSavingNotes(false);
    }
  }

  const recipe = entry.recipe;
  return (
    <ScrollView
      ref={scrollViewRef}
      contentContainerStyle={styles.detailContent}
      keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.detailHeader}>
        <Pressable
          accessibilityLabel="Back to saved recipes"
          hitSlop={10}
          onPress={onBack}
          style={styles.detailBack}
        >
          <Ionicons color={colors.moss} name="arrow-back" size={21} />
        </Pressable>
        <Text style={styles.detailHeaderTitle}>Saved recipe</Text>
        <Pressable
          accessibilityLabel={`Delete ${recipe.title}`}
          hitSlop={10}
          onPress={onDelete}
          style={styles.detailDelete}
        >
          <Ionicons color={colors.red} name="trash-outline" size={19} />
        </Pressable>
      </View>
      <Text style={styles.detailGenerated}>
        GENERATED {formatGeneratedDate(entry.generatedAt).toUpperCase()}
      </Text>
      <Text style={styles.detailTitle}>{recipe.title}</Text>
      {recipe.cuisine ? (
        <View style={styles.recipeCuisine}>
          <Ionicons name="globe-outline" color={colors.moss} size={13} />
          <Text style={styles.recipeCuisineText}>{recipe.cuisine}</Text>
        </View>
      ) : null}
      <Text style={styles.recipeDescription}>{recipe.description}</Text>
      <DietaryMarks
        glutenFree={recipe.is_gluten_free}
        ketoFriendly={recipe.is_keto_friendly ?? false}
        vegan={recipe.is_vegan}
        vegetarian={recipe.is_vegetarian ?? false}
      />
      <RecipeDishImage
        image={entry.image}
        onImageResolved={(image) => {
          void onSaveImage(entry, image);
        }}
        title={recipe.title}
      />
      <RecipeFacts calorieIcon="heart-outline" recipe={recipe} />
      <Text style={styles.recipeSubheading}>Method</Text>
      {recipe.steps.map((step) => (
        <View key={step.order} style={styles.step}>
          <Text style={styles.stepNumber}>{step.order}</Text>
          <Text style={styles.stepText}>{step.text}</Text>
        </View>
      ))}
      {recipe.storage_tip ? (
        <Text style={styles.storageText}>Storage: {recipe.storage_tip}</Text>
      ) : null}
      <View style={styles.notesCard}>
        <View style={styles.notesHeader}>
          <View>
            <Text style={styles.notesTitle}>Add notes</Text>
            <Text style={styles.notesHint}>Keep substitutions, tweaks, or reminders.</Text>
          </View>
          <Text style={styles.notesCount}>
            {noteWords}/{NOTE_WORD_LIMIT}
          </Text>
        </View>
        <TextInput
          multiline
          onChangeText={(value) => setNotes(limitRecipeNotes(value))}
          onFocus={() => {
            requestAnimationFrame(() => scrollViewRef.current?.scrollToEnd({ animated: true }));
          }}
          placeholder="e.g. Add chili flakes next time"
          placeholderTextColor="#8B948C"
          style={styles.notesInput}
          textAlignVertical="top"
          value={notes}
        />
        <Pressable
          disabled={savingNotes}
          onPress={saveNotes}
          style={[styles.notesSave, savingNotes && styles.notesSaveDisabled]}
        >
          {savingNotes ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <>
              <Ionicons color="#FFFFFF" name="checkmark" size={16} />
              <Text style={styles.notesSaveText}>Save notes</Text>
            </>
          )}
        </Pressable>
      </View>
    </ScrollView>
  );
}

function ShoppingBlock({
  loading,
  plan,
  onRequestLocation,
}: {
  loading: boolean;
  plan: PlanResponse;
  onRequestLocation: () => void;
}) {
  const [locationServicesEnabled, setLocationServicesEnabled] = useState(false);
  const offersByItem = plan.stores.reduce<Record<string, typeof plan.stores>>((groups, offer) => {
    const requestedItem = offer.requested_item_name ?? offer.item_name;
    groups[requestedItem] = [...(groups[requestedItem] ?? []), offer];
    return groups;
  }, {});

  useEffect(() => {
    let active = true;
    const refreshLocationServices = () => {
      void Location.hasServicesEnabledAsync()
        .then((enabled) => {
          if (active) {
            setLocationServicesEnabled(enabled);
          }
        })
        .catch(() => {
          if (active) {
            setLocationServicesEnabled(false);
          }
        });
    };
    refreshLocationServices();
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        refreshLocationServices();
      }
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  return (
    <View style={styles.shoppingBlock}>
      <Text style={[styles.recipeSubheading, styles.shoppingSubheading]}>A tiny top-up</Text>
      <View style={styles.missingRow}>
        {plan.missing_ingredients.map((item) => (
          <View key={item} style={styles.missingPill}>
            <Ionicons name="add" color={colors.peachInk} size={14} />
            <Text style={styles.missingPillText}>{titleCase(item)}</Text>
          </View>
        ))}
      </View>
      {plan.stores.length ? (
        <View style={styles.storeList}>
          {Object.entries(offersByItem).map(([item, offers]) => (
            <View key={item} style={styles.storeGroup}>
              <Text style={styles.storeGroupLabel}>For {titleCase(item)}</Text>
              {offers.slice(0, 2).map((store, index) => (
                <View
                  key={`${store.store_name}-${store.item_name}-${index}`}
                  style={styles.storeRow}
                >
                  <StoreOfferVisual thumbnailUrl={store.thumbnail_url} />
                  <View style={styles.storeCopy}>
                    <Text style={styles.storeName}>{store.store_name}</Text>
                    <Text style={styles.storeProduct}>{store.item_name}</Text>
                    <Text style={styles.storeAddress}>
                      {store.distance_miles ? `${store.distance_miles} mi · ` : ''}
                      {store.address ?? 'Online or local offer'}
                    </Text>
                  </View>
                  <Text style={styles.storePrice}>{store.price ?? 'Price unavailable'}</Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      ) : (
        <Pressable
          disabled={loading}
          onPress={onRequestLocation}
          style={[styles.locationPrompt, loading && styles.disabledMediaAction]}
        >
          {loading ? (
            <ActivityIndicator color={colors.moss} size="small" />
          ) : (
            <Ionicons name="location-outline" color={colors.moss} size={17} />
          )}
          <Text style={styles.locationPromptText}>
            {loading
              ? 'Finding grocery offers...'
              : locationServicesEnabled
                ? 'Check for availability nearby'
                : 'Use my location to find grocery offers'}
          </Text>
        </Pressable>
      )}
      {plan.shopping_notice ? (
        <Text style={styles.shoppingNotice}>{plan.shopping_notice}</Text>
      ) : null}
    </View>
  );
}

function StoreOfferVisual({ thumbnailUrl }: { thumbnailUrl?: string | null }) {
  const [imageFailed, setImageFailed] = useState(false);
  if (thumbnailUrl && !imageFailed) {
    return (
      <Image
        accessibilityLabel="Product thumbnail"
        onError={() => setImageFailed(true)}
        resizeMode="cover"
        source={{ uri: thumbnailUrl }}
        style={styles.storeThumbnail}
      />
    );
  }
  return (
    <View style={styles.storeIcon}>
      <Ionicons name="storefront-outline" color={colors.moss} size={16} />
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { backgroundColor: colors.canvas, flex: 1 },
  scrollContent: { paddingBottom: 48 },
  content: { paddingTop: 12 },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 28,
  },
  brandRow: { alignItems: 'center', flexDirection: 'row' },
  mark: { borderRadius: 12, height: 34, marginRight: 9, overflow: 'hidden', width: 34 },
  markImage: { height: 34, width: 34 },
  brand: { color: colors.ink, fontSize: 19, fontWeight: '800', letterSpacing: -0.5 },
  pageBack: { alignItems: 'center', flexDirection: 'row', gap: 6, minHeight: 34 },
  pageBackText: { color: colors.moss, fontSize: 14, fontWeight: '800' },
  infoButton: {
    alignItems: 'center',
    backgroundColor: '#E8EEE7',
    borderRadius: 17,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  intro: { marginBottom: 29 },
  kicker: {
    color: colors.moss,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.35,
    marginBottom: 10,
  },
  title: {
    color: colors.ink,
    fontSize: 40,
    fontWeight: '800',
    letterSpacing: -1.5,
    lineHeight: 42,
  },
  lede: { color: colors.muted, fontSize: 16, lineHeight: 23, marginTop: 13, maxWidth: 370 },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderRadius: 22,
    borderWidth: 1,
  },
  cuisineCard: { marginBottom: 16, padding: 18 },
  cardHeading: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  eyebrow: { color: colors.muted, fontSize: 10, fontWeight: '800', letterSpacing: 1.1 },
  sectionTitle: {
    color: colors.ink,
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: -0.45,
    marginTop: 4,
  },
  smallIcon: {
    alignItems: 'center',
    backgroundColor: colors.sky,
    borderRadius: 15,
    height: 31,
    justifyContent: 'center',
    width: 31,
  },
  cuisinePicker: {
    alignItems: 'center',
    backgroundColor: '#F4F6F1',
    borderRadius: 15,
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 17,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  cuisineName: { color: colors.ink, fontSize: 16, fontWeight: '800' },
  cuisineMeta: { color: colors.muted, fontSize: 12, marginTop: 2 },
  tasteProfileBlock: { marginTop: 18 },
  tasteProfileHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  tasteProfileCount: {
    alignSelf: 'flex-end',
    color: colors.muted,
    fontSize: 10,
    fontWeight: '700',
    marginTop: 6,
  },
  tasteProfileInput: {
    backgroundColor: '#FFFFFF',
    borderColor: '#D5E0D2',
    borderRadius: 12,
    borderWidth: 1,
    color: colors.ink,
    fontSize: 14,
    lineHeight: 19,
    marginTop: 9,
    minHeight: 58,
    paddingHorizontal: 11,
    paddingVertical: 10,
  },
  tasteProfileExamples: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 7 },
  preferenceBlock: { marginTop: 18 },
  preferenceLabel: {
    color: colors.muted,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.95,
    marginBottom: 8,
  },
  dietChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  dietChoice: {
    alignItems: 'center',
    backgroundColor: '#F1F5EF',
    borderColor: '#DDE6DA',
    borderRadius: 11,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 5,
    minHeight: 37,
    paddingHorizontal: 10,
  },
  dietChoiceSelected: { backgroundColor: colors.moss, borderColor: colors.moss },
  dietChoiceText: { color: colors.moss, fontSize: 12, fontWeight: '800' },
  dietChoiceTextSelected: { color: '#FFFFFF' },
  checkboxChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  preferenceCheckbox: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#D5E0D2',
    borderRadius: 12,
    borderWidth: 1,
    flex: 1,
    flexDirection: 'row',
    gap: 6,
    minHeight: 43,
    minWidth: 142,
    paddingHorizontal: 9,
  },
  preferenceCheckboxSelected: { backgroundColor: '#EDF5E9', borderColor: '#83AA72' },
  checkboxMark: {
    alignItems: 'center',
    borderColor: '#9EACA0',
    borderRadius: 5,
    borderWidth: 1.5,
    height: 19,
    justifyContent: 'center',
    width: 19,
  },
  checkboxMarkSelected: { backgroundColor: colors.moss, borderColor: colors.moss },
  preferenceCheckboxText: { color: colors.ink, flexShrink: 1, fontSize: 12, fontWeight: '800' },
  scanCard: {
    alignItems: 'center',
    backgroundColor: colors.moss,
    borderRadius: 25,
    marginBottom: 20,
    overflow: 'hidden',
    padding: 23,
  },
  scanArtwork: {
    backgroundColor: '#416B58',
    borderRadius: 17,
    height: 114,
    marginBottom: 20,
    overflow: 'hidden',
    paddingHorizontal: 18,
    paddingTop: 17,
    width: '100%',
  },
  shelfTop: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    gap: 10,
    height: 40,
    paddingHorizontal: 15,
  },
  jar: { backgroundColor: '#EAC766', borderRadius: 5, height: 29, width: 20 },
  bottle: { backgroundColor: '#DEEEE4', borderRadius: 5, height: 39, width: 18 },
  jarSmall: { backgroundColor: '#D9795C', borderRadius: 5, height: 22, width: 22 },
  shelfLine: { backgroundColor: '#254B3B', height: 5, marginTop: 7, width: '100%' },
  shelfBottom: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    height: 42,
    justifyContent: 'center',
  },
  orange: { backgroundColor: '#F4B663', borderRadius: 15, height: 26, width: 26 },
  orangeSmall: { backgroundColor: '#E48553', borderRadius: 11, height: 20, width: 20 },
  leafy: {
    backgroundColor: '#A8CF74',
    borderRadius: 17,
    height: 31,
    transform: [{ rotate: '23deg' }],
    width: 22,
  },
  scanTitle: { color: '#FFFFFF', fontSize: 24, fontWeight: '800', letterSpacing: -0.6 },
  scanCopy: { color: '#D6E3D9', fontSize: 14, lineHeight: 20, marginTop: 6, textAlign: 'center' },
  scanActions: { gap: 10, marginTop: 19, width: '100%' },
  selectedMedia: {
    backgroundColor: '#315746',
    borderColor: '#638C77',
    borderRadius: 14,
    borderWidth: 1,
    marginTop: 13,
    padding: 10,
    width: '100%',
  },
  selectedMediaHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 7,
  },
  selectedMediaTitle: { color: '#DDEEDF', fontSize: 10, fontWeight: '900', letterSpacing: 0.8 },
  clearMediaText: { color: '#FFFFFF', fontSize: 11, fontWeight: '800' },
  disabledMediaAction: { opacity: 0.4 },
  selectedMediaRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 9,
    minHeight: 38,
    paddingVertical: 4,
  },
  selectedPhoto: { backgroundColor: '#557665', borderRadius: 6, height: 36, width: 36 },
  selectedVideo: {
    alignItems: 'center',
    backgroundColor: '#557665',
    borderRadius: 6,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  selectedMediaName: { color: '#FFFFFF', flex: 1, fontSize: 12, fontWeight: '700' },
  removeMediaButton: {
    alignItems: 'center',
    backgroundColor: '#6F3E3E',
    borderRadius: 8,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: colors.lime,
    borderRadius: 14,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: 16,
  },
  disabledButton: { opacity: 0.7 },
  primaryButtonText: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  secondaryButton: {
    alignItems: 'center',
    borderColor: '#83A895',
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    minHeight: 46,
  },
  secondaryButtonText: { color: '#F2F8F1', fontSize: 14, fontWeight: '700' },
  inventoryHeader: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  inventoryTitle: { marginTop: 0 },
  inventoryLabel: { marginTop: 8 },
  itemCount: { color: colors.muted, fontSize: 12, marginBottom: 3 },
  inventoryCard: { padding: 15 },
  chipWrap: { alignItems: 'flex-start', flexDirection: 'row', flexWrap: 'wrap' },
  addChip: {
    alignItems: 'center',
    borderColor: '#A9B7AA',
    borderRadius: 15,
    borderStyle: 'dashed',
    borderWidth: 1,
    flexDirection: 'row',
    gap: 3,
    height: 45,
    marginBottom: 8,
    paddingHorizontal: 11,
  },
  addChipText: { color: colors.moss, fontSize: 13, fontWeight: '700' },
  emptyInventory: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 11,
    justifyContent: 'center',
    minHeight: 72,
  },
  emptyText: { color: colors.muted, fontSize: 13, lineHeight: 19, marginBottom: 12 },
  notice: {
    alignItems: 'flex-start',
    backgroundColor: '#F0F7EB',
    borderRadius: 11,
    flexDirection: 'row',
    gap: 7,
    marginTop: 10,
    padding: 10,
  },
  noticeText: { color: colors.mossDark, flex: 1, fontSize: 12, lineHeight: 17 },
  stapleBlock: { marginTop: 25 },
  stapleRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  staple: {
    alignItems: 'center',
    backgroundColor: '#ECEEE9',
    borderRadius: 13,
    flexDirection: 'row',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  stapleActive: { backgroundColor: colors.lime },
  stapleText: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  stapleTextActive: { color: colors.limeInk },
  nextPageButton: {
    alignItems: 'center',
    backgroundColor: colors.moss,
    borderRadius: 16,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    marginTop: 4,
    minHeight: 53,
  },
  nextPageButtonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
  pantryIntro: { marginBottom: 22 },
  pageTitle: {
    color: colors.ink,
    fontSize: 32,
    fontWeight: '800',
    letterSpacing: -1,
    lineHeight: 36,
    marginTop: 2,
  },
  pageLede: { color: colors.muted, fontSize: 14, lineHeight: 20, marginTop: 7 },
  planButton: {
    alignItems: 'center',
    backgroundColor: colors.lime,
    borderRadius: 16,
    flexDirection: 'row',
    gap: 9,
    justifyContent: 'center',
    marginTop: 28,
    minHeight: 56,
  },
  planButtonDisabled: { backgroundColor: '#E0E4DD' },
  planButtonText: { color: colors.ink, fontSize: 16, fontWeight: '800' },
  pantryTryAnotherButton: {
    alignItems: 'center',
    backgroundColor: '#F1F5EF',
    borderColor: '#D7E2D3',
    borderRadius: 15,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 7,
    justifyContent: 'center',
    marginTop: 10,
    minHeight: 48,
  },
  pantryTryAnotherText: { color: colors.moss, fontSize: 14, fontWeight: '800' },
  abortButton: {
    alignItems: 'center',
    alignSelf: 'center',
    borderColor: '#AFC4B2',
    borderRadius: 13,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
    marginTop: 10,
    minHeight: 42,
    paddingHorizontal: 16,
  },
  abortButtonDisabled: { opacity: 0.55 },
  abortButtonText: { color: colors.moss, fontSize: 13, fontWeight: '800' },
  resultWrap: { marginTop: 34 },
  resultWrapFull: { marginTop: 4 },
  resultHeader: { alignItems: 'center', flexDirection: 'row', gap: 8, marginBottom: 11 },
  demoPill: {
    backgroundColor: colors.yellow,
    borderRadius: 6,
    color: '#7A6020',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.8,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  resultCard: { backgroundColor: colors.surface, borderRadius: 23, padding: 19 },
  recipeFlag: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: colors.lime,
    borderRadius: 10,
    flexDirection: 'row',
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 6,
  },
  recipeFlagText: { color: colors.limeInk, fontSize: 9, fontWeight: '900', letterSpacing: 0.75 },
  noPlanIcon: {
    alignItems: 'center',
    backgroundColor: colors.sky,
    borderRadius: 18,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  recipeTitle: {
    color: colors.ink,
    fontSize: 27,
    fontWeight: '800',
    letterSpacing: -0.85,
    marginTop: 13,
  },
  recipeCuisine: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: '#EEF4EA',
    borderRadius: 9,
    flexDirection: 'row',
    gap: 4,
    marginTop: 9,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  recipeCuisineText: {
    color: colors.moss,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.45,
    textTransform: 'uppercase',
  },
  recipeDescription: { color: colors.muted, fontSize: 14, lineHeight: 20, marginTop: 6 },
  recipeFacts: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 13 },
  recipeFact: {
    alignItems: 'center',
    backgroundColor: '#F2F6F0',
    borderRadius: 11,
    flexDirection: 'row',
    gap: 6,
    minHeight: 46,
    paddingHorizontal: 9,
  },
  recipeFactValue: { color: colors.ink, fontSize: 12, fontWeight: '900' },
  recipeFactLabel: { color: colors.muted, fontSize: 10, fontWeight: '700', marginTop: 1 },
  recipeSubheading: { color: colors.ink, fontSize: 16, fontWeight: '800', marginTop: 22 },
  step: { alignItems: 'flex-start', flexDirection: 'row', gap: 10, marginTop: 13 },
  stepNumber: {
    backgroundColor: colors.sky,
    borderRadius: 10,
    color: colors.moss,
    fontSize: 11,
    fontWeight: '900',
    height: 20,
    overflow: 'hidden',
    paddingTop: 3,
    textAlign: 'center',
    width: 20,
  },
  stepText: { color: '#3E4940', flex: 1, fontSize: 13, lineHeight: 19 },
  storageText: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 12 },
  againButton: {
    alignItems: 'center',
    borderColor: '#ABC2B1',
    borderRadius: 13,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
    marginTop: 21,
    minHeight: 45,
  },
  againText: { color: colors.moss, fontSize: 13, fontWeight: '800' },
  saveButton: {
    alignItems: 'center',
    backgroundColor: '#EDF4EB',
    borderRadius: 13,
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
    marginTop: 21,
    minHeight: 45,
  },
  saveButtonSaved: { backgroundColor: colors.moss },
  saveText: { color: colors.moss, fontSize: 13, fontWeight: '800' },
  saveTextSaved: { color: '#FFFFFF' },
  savedRecipes: { marginTop: 28 },
  savedCount: {
    backgroundColor: '#EAF1E7',
    borderRadius: 9,
    color: colors.moss,
    fontSize: 11,
    fontWeight: '900',
    overflow: 'hidden',
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  savedRecipeCard: { paddingHorizontal: 15 },
  savedRecipeRow: {
    alignItems: 'center',
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 14,
  },
  savedRecipeCopy: { flex: 1 },
  savedRecipeTitle: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  savedRecipeCuisine: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '700',
    marginTop: 3,
    textTransform: 'uppercase',
  },
  shoppingBlock: { backgroundColor: '#FFF8F2', borderRadius: 14, marginTop: 19, padding: 14 },
  shoppingSubheading: { marginTop: 11 },
  missingRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  missingPill: {
    alignItems: 'center',
    backgroundColor: colors.peach,
    borderRadius: 10,
    flexDirection: 'row',
    gap: 3,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  missingPillText: { color: colors.peachInk, fontSize: 12, fontWeight: '700' },
  locationPrompt: {
    alignItems: 'center',
    borderColor: '#E7CCB8',
    borderRadius: 11,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
    marginTop: 13,
    minHeight: 42,
    paddingHorizontal: 8,
  },
  locationPromptText: { color: colors.moss, fontSize: 12, fontWeight: '700', textAlign: 'center' },
  storeList: { gap: 9, marginTop: 14 },
  storeGroup: { gap: 8, marginBottom: 8 },
  storeGroupLabel: { color: colors.peachInk, fontSize: 11, fontWeight: '800', marginTop: 3 },
  storeRow: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  storeIcon: {
    alignItems: 'center',
    backgroundColor: '#F0EEE5',
    borderRadius: 12,
    height: 28,
    justifyContent: 'center',
    width: 28,
  },
  storeThumbnail: {
    backgroundColor: '#F0EEE5',
    borderRadius: 8,
    height: 32,
    width: 32,
  },
  storeCopy: { flex: 1 },
  storeName: { color: colors.ink, fontSize: 12, fontWeight: '800' },
  storeProduct: { color: colors.ink, fontSize: 10, marginTop: 2 },
  storeAddress: { color: colors.muted, fontSize: 10, marginTop: 2 },
  storePrice: {
    color: colors.moss,
    fontSize: 10,
    fontWeight: '800',
    maxWidth: 90,
    textAlign: 'right',
  },
  shoppingNotice: { color: colors.muted, fontSize: 10, lineHeight: 14, marginTop: 12 },
  modalBackdrop: {
    alignItems: 'center',
    backgroundColor: 'rgba(20, 31, 24, 0.44)',
    flex: 1,
    justifyContent: 'flex-end',
    paddingBottom: 12,
  },
  sidebarOverlay: { backgroundColor: 'rgba(20, 31, 24, 0.44)', flex: 1, flexDirection: 'row' },
  sidebarDismiss: { flex: 1 },
  sidebar: {
    backgroundColor: colors.canvas,
    minHeight: '100%',
    paddingBottom: 26,
    paddingHorizontal: 17,
    paddingTop: 57,
    ...shadow,
  },
  sidebarHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 24,
  },
  sidebarEyebrow: { color: colors.moss, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  sidebarTitle: {
    color: colors.ink,
    fontSize: 25,
    fontWeight: '800',
    letterSpacing: -0.7,
    marginTop: 4,
  },
  sidebarClose: {
    alignItems: 'center',
    backgroundColor: '#E7EEE6',
    borderRadius: 17,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  sidebarList: { gap: 9, paddingBottom: 26 },
  sidebarRecipeRow: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'row',
    minHeight: 70,
    overflow: 'hidden',
  },
  sidebarRecipeOpen: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: 9,
    minWidth: 0,
    paddingHorizontal: 10,
    paddingVertical: 10,
  },
  sidebarRecipeIcon: {
    alignItems: 'center',
    backgroundColor: '#EAF2E7',
    borderRadius: 12,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  sidebarRecipeCopy: { flex: 1, minWidth: 0 },
  sidebarRecipeTitle: { color: colors.ink, fontSize: 13, fontWeight: '800' },
  sidebarRecipeMeta: { color: colors.muted, fontSize: 10, marginTop: 3 },
  sidebarDelete: {
    alignItems: 'center',
    borderLeftColor: colors.line,
    borderLeftWidth: 1,
    height: '100%',
    justifyContent: 'center',
    width: 43,
  },
  sidebarEmpty: { alignItems: 'center', flex: 1, justifyContent: 'center', paddingHorizontal: 30 },
  sidebarEmptyTitle: { color: colors.ink, fontSize: 16, fontWeight: '800', marginTop: 12 },
  sidebarEmptyCopy: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 5,
    textAlign: 'center',
  },
  sheet: { backgroundColor: colors.canvas, borderRadius: 25, padding: 21 },
  sheetHandle: {
    alignSelf: 'center',
    backgroundColor: '#C8CEC6',
    borderRadius: 4,
    height: 4,
    marginBottom: 20,
    width: 38,
  },
  sheetTitle: { color: colors.ink, fontSize: 23, fontWeight: '800', letterSpacing: -0.6 },
  sheetCopy: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 5 },
  cuisinePreferenceSummary: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: '#EDF4EB',
    borderRadius: 9,
    flexDirection: 'row',
    gap: 5,
    marginTop: 13,
    paddingHorizontal: 9,
    paddingVertical: 6,
  },
  cuisinePreferenceText: {
    color: colors.moss,
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'capitalize',
  },
  cuisineGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 9, marginTop: 20 },
  cuisineOption: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 5,
    justifyContent: 'center',
    minHeight: 43,
    paddingHorizontal: 13,
  },
  cuisineOptionSelected: { backgroundColor: colors.moss, borderColor: colors.moss },
  cuisineOptionText: { color: colors.ink, fontSize: 13, fontWeight: '700' },
  cuisineOptionTextSelected: { color: '#FFFFFF' },
  addDialog: {
    backgroundColor: colors.canvas,
    borderRadius: 22,
    marginBottom: 'auto',
    marginTop: 'auto',
    padding: 21,
  },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderRadius: 12,
    borderWidth: 1,
    color: colors.ink,
    fontSize: 15,
    marginTop: 19,
    minHeight: 48,
    paddingHorizontal: 13,
  },
  inputLabel: {
    color: colors.muted,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.8,
    marginTop: 17,
  },
  inputCompact: {
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderRadius: 12,
    borderWidth: 1,
    color: colors.ink,
    fontSize: 15,
    marginTop: 7,
    minHeight: 48,
    paddingHorizontal: 13,
  },
  expiresSoonOption: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#D5E0D2',
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 9,
    marginTop: 12,
    minHeight: 58,
    paddingHorizontal: 11,
  },
  expiresSoonOptionSelected: { backgroundColor: '#FFF8E8', borderColor: '#F0D58B' },
  expiresSoonMark: {
    alignItems: 'center',
    borderColor: '#9EACA0',
    borderRadius: 5,
    borderWidth: 1.5,
    height: 19,
    justifyContent: 'center',
    width: 19,
  },
  expiresSoonMarkSelected: { backgroundColor: '#E5A72B', borderColor: '#E5A72B' },
  expiresSoonCopy: { flex: 1 },
  expiresSoonTitle: { color: colors.ink, fontSize: 13, fontWeight: '800' },
  expiresSoonHint: { color: colors.muted, fontSize: 11, marginTop: 1 },
  dialogActions: { flexDirection: 'row', gap: 10, justifyContent: 'flex-end', marginTop: 16 },
  dialogCancel: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 42,
    paddingHorizontal: 13,
  },
  dialogCancelText: { color: colors.muted, fontSize: 13, fontWeight: '700' },
  dialogRemove: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
    justifyContent: 'center',
    marginRight: 'auto',
    minHeight: 42,
    paddingHorizontal: 7,
  },
  dialogRemoveText: { color: colors.red, fontSize: 13, fontWeight: '800' },
  dialogConfirm: {
    alignItems: 'center',
    backgroundColor: colors.moss,
    borderRadius: 11,
    justifyContent: 'center',
    minHeight: 42,
    paddingHorizontal: 15,
  },
  dialogConfirmText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800' },
  detailSafeArea: { backgroundColor: colors.canvas, flex: 1 },
  detailKeyboardAvoiding: { flex: 1 },
  detailContent: { paddingBottom: 42, paddingHorizontal: 16, paddingTop: 12 },
  generatedDetailContent: { paddingTop: 12 },
  detailHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 28,
  },
  detailBack: {
    alignItems: 'center',
    backgroundColor: '#E7EEE6',
    borderRadius: 17,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  detailHeaderTitle: { color: colors.ink, fontSize: 16, fontWeight: '800' },
  detailHeaderSpacer: { width: 34 },
  detailDelete: {
    alignItems: 'center',
    backgroundColor: '#FBECEA',
    borderRadius: 17,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  detailGenerated: { color: colors.muted, fontSize: 10, fontWeight: '900', letterSpacing: 0.65 },
  detailTitle: {
    color: colors.ink,
    fontSize: 31,
    fontWeight: '800',
    letterSpacing: -1,
    marginTop: 9,
  },
  notesCard: { backgroundColor: '#EEF4EC', borderRadius: 17, marginTop: 22, padding: 14 },
  notesHeader: { alignItems: 'flex-start', flexDirection: 'row', justifyContent: 'space-between' },
  notesTitle: { color: colors.ink, fontSize: 16, fontWeight: '800' },
  notesHint: { color: colors.muted, fontSize: 11, marginTop: 3 },
  notesCount: { color: colors.moss, fontSize: 11, fontWeight: '800' },
  notesInput: {
    backgroundColor: '#FFFFFF',
    borderColor: '#D9E4D6',
    borderRadius: 12,
    borderWidth: 1,
    color: colors.ink,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 12,
    minHeight: 90,
    padding: 11,
  },
  notesSave: {
    alignItems: 'center',
    alignSelf: 'flex-end',
    backgroundColor: colors.moss,
    borderRadius: 10,
    flexDirection: 'row',
    gap: 5,
    justifyContent: 'center',
    marginTop: 10,
    minHeight: 38,
    paddingHorizontal: 12,
  },
  notesSaveDisabled: { opacity: 0.65 },
  notesSaveText: { color: '#FFFFFF', fontSize: 12, fontWeight: '800' },
});
