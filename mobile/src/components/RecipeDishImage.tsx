import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { getRecipeImage } from '../api/client';
import { colors } from '../constants/theme';
import type { RecipeImage } from '../types';

type Props = {
  title: string;
  image?: RecipeImage | null;
  onImageResolved?: (image: RecipeImage | null) => void;
};

export function RecipeDishImage({ title, image, onImageResolved }: Props) {
  if (image !== undefined) {
    return <ResolvedRecipeDishImage image={image} />;
  }
  return <FetchedRecipeDishImage title={title} onImageResolved={onImageResolved} />;
}

function FetchedRecipeDishImage({
  title,
  onImageResolved,
}: Pick<Props, 'title' | 'onImageResolved'>) {
  const [image, setImage] = useState<RecipeImage | null>(null);
  const [resolved, setResolved] = useState(false);
  const onImageResolvedRef = useRef(onImageResolved);

  useEffect(() => {
    onImageResolvedRef.current = onImageResolved;
  }, [onImageResolved]);

  useEffect(() => {
    let active = true;
    void getRecipeImage(title)
      .then((result) => {
        if (!active) {
          return;
        }
        setImage(result);
        onImageResolvedRef.current?.(result);
      })
      .catch(() => {
        // Leave unresolved persisted images retryable after transient request failures.
      })
      .finally(() => {
        if (active) {
          setResolved(true);
        }
      });

    return () => {
      active = false;
    };
  }, [title]);

  if (resolved && !image) {
    return null;
  }
  if (!image) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.moss} />
        <Text style={styles.loadingText}>Creating a dish preview...</Text>
      </View>
    );
  }
  return <ResolvedRecipeDishImage image={image} />;
}

function ResolvedRecipeDishImage({ image }: { image: RecipeImage | null }) {
  const [failed, setFailed] = useState(false);
  if (!image || failed) {
    return null;
  }

  const isGenerated = image.attribution === 'Generated for PantryPilot';
  const openSource = () => {
    if (image.source_url) {
      void Linking.openURL(image.source_url);
    }
  };

  return (
    <View style={styles.wrap}>
      <Image
        accessibilityLabel={image.alt}
        onError={() => setFailed(true)}
        resizeMode="cover"
        source={{ uri: image.url }}
        style={styles.image}
      />
      {isGenerated ? (
        <View style={styles.attribution}>
          <Ionicons name="sparkles-outline" color={colors.muted} size={14} />
          <Text numberOfLines={1} style={styles.attributionText}>
            AI-generated dish preview
          </Text>
        </View>
      ) : (
        <Pressable disabled={!image.source_url} onPress={openSource} style={styles.attribution}>
          <Ionicons name="information-circle-outline" color={colors.muted} size={14} />
          <Text numberOfLines={1} style={styles.attributionText}>
            {image.attribution ? `Photo: ${image.attribution}` : 'Open-license photo'}
            {image.license ? ` · CC ${image.license.toUpperCase()}` : ''}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  loading: {
    alignItems: 'center',
    backgroundColor: '#EEF2EB',
    borderRadius: 14,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    marginTop: 16,
    minHeight: 116,
  },
  loadingText: { color: colors.muted, fontSize: 12 },
  wrap: { marginTop: 16, overflow: 'hidden' },
  image: {
    backgroundColor: '#E8ECE6',
    borderRadius: 14,
    height: 182,
    width: '100%',
  },
  attribution: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
    marginTop: 6,
  },
  attributionText: { color: colors.muted, flex: 1, fontSize: 10 },
});
