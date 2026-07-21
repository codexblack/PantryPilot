import { StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { colors } from '../constants/theme';

type Props = {
  value?: number | null;
};

const ARC_LENGTH = 220;

export function FastPerishingGauge({ value }: Props) {
  const hasScore = value !== null && value !== undefined;
  const score = Math.max(0, Math.min(100, value ?? 0));
  const dashOffset = ARC_LENGTH * (1 - score / 100);

  return (
    <View
      accessibilityLabel={
        hasScore
          ? `${score}% of fast-perishing inventory items are used in this recipe.`
          : 'No fast-perishing inventory items were identified.'
      }
      style={styles.card}
    >
      <Text style={styles.kicker}>FAST-PERISHING UTILIZATION</Text>
      <View style={styles.gauge}>
        <Svg height={112} viewBox="0 0 180 112" width={180}>
          <Path
            d="M20 92 A70 70 0 0 1 160 92"
            fill="none"
            stroke="#E2E9DF"
            strokeLinecap="round"
            strokeWidth={13}
          />
          {hasScore ? (
            <Path
              d="M20 92 A70 70 0 0 1 160 92"
              fill="none"
              stroke={colors.moss}
              strokeDasharray={`${ARC_LENGTH} ${ARC_LENGTH}`}
              strokeDashoffset={dashOffset}
              strokeLinecap="round"
              strokeWidth={13}
            />
          ) : null}
        </Svg>
        <View pointerEvents="none" style={styles.scoreWrap}>
          <Text style={styles.score}>{hasScore ? `${score}%` : '—'}</Text>
          <Text style={styles.scoreLabel}>{hasScore ? 'used' : 'none found'}</Text>
        </View>
      </View>
      <Text style={styles.copy}>
        {hasScore
          ? 'of the fast-perishing items in your inventory appear in this dish.'
          : 'No fast-perishing items were identified in your inventory.'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    alignItems: 'center',
    backgroundColor: '#F1F6EE',
    borderRadius: 16,
    marginTop: 20,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  kicker: { color: colors.moss, fontSize: 10, fontWeight: '900', letterSpacing: 0.9 },
  gauge: { height: 104, marginTop: 2, width: 180 },
  scoreWrap: { alignItems: 'center', left: 0, position: 'absolute', right: 0, top: 42 },
  score: { color: colors.ink, fontSize: 29, fontWeight: '900', letterSpacing: -0.8 },
  scoreLabel: {
    color: colors.muted,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.45,
    marginTop: -1,
    textTransform: 'uppercase',
  },
  copy: { color: colors.muted, fontSize: 12, lineHeight: 17, maxWidth: 280, textAlign: 'center' },
});
