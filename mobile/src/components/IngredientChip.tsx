import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { colors } from '../constants/theme';
import type { Ingredient } from '../types';

type Props = {
  ingredient: Ingredient;
  disabled?: boolean;
  onPress: () => void;
};

export function IngredientChip({ ingredient, disabled = false, onPress }: Props) {
  const useSoon = ingredient.freshness === 'use_soon';
  return (
    <Pressable
      accessibilityHint="Opens quantity and remove controls"
      accessibilityLabel={`Edit ${ingredient.name}`}
      disabled={disabled}
      onPress={onPress}
      style={[styles.chip, useSoon && styles.urgentChip, disabled && styles.disabled]}
    >
      <View style={styles.copy}>
        <Text numberOfLines={1} style={styles.name}>
          {ingredient.name}
        </Text>
        <Text style={styles.quantity}>{ingredient.quantity || 'Quantity not set'}</Text>
      </View>
      {useSoon ? <View style={styles.soonDot} /> : null}
      <View style={styles.edit}>
        <Ionicons name="pencil-outline" size={14} color={colors.moss} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderRadius: 15,
    borderWidth: 1,
    flexDirection: 'row',
    marginBottom: 8,
    marginRight: 8,
    maxWidth: '100%',
    minHeight: 45,
    paddingBottom: 7,
    paddingLeft: 11,
    paddingTop: 7,
  },
  urgentChip: { backgroundColor: '#FFF8E8', borderColor: '#F0D58B' },
  copy: { minWidth: 0 },
  name: { color: colors.ink, fontSize: 13, fontWeight: '700', maxWidth: 135 },
  quantity: { color: colors.muted, fontSize: 11, marginTop: 1 },
  soonDot: { backgroundColor: '#E5A72B', borderRadius: 4, height: 7, marginLeft: 8, width: 7 },
  edit: {
    alignItems: 'center',
    backgroundColor: '#EDF4EB',
    borderRadius: 10,
    height: 25,
    justifyContent: 'center',
    marginHorizontal: 5,
    width: 25,
  },
  disabled: { opacity: 0.55 },
});
