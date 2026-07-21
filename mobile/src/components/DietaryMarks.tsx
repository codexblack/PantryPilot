import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line, Path } from 'react-native-svg';

type DietaryMarksProps = {
  vegan: boolean;
  vegetarian: boolean;
  ketoFriendly: boolean;
  glutenFree: boolean;
};

type MarkKind = 'vegan' | 'vegetarian' | 'ketoFriendly' | 'glutenFree';

const markColors: Record<MarkKind, string> = {
  vegan: '#9BCB2D',
  vegetarian: '#25866B',
  ketoFriendly: '#6952A7',
  glutenFree: '#F18721',
};

export function DietaryMarks({ vegan, vegetarian, ketoFriendly, glutenFree }: DietaryMarksProps) {
  const marks: { kind: MarkKind; label: string }[] = [
    ...(vegan ? [{ kind: 'vegan' as const, label: 'Vegan' }] : []),
    ...(!vegan && vegetarian ? [{ kind: 'vegetarian' as const, label: 'Vegetarian' }] : []),
    ...(ketoFriendly ? [{ kind: 'ketoFriendly' as const, label: 'Keto-friendly' }] : []),
    ...(glutenFree ? [{ kind: 'glutenFree' as const, label: 'Gluten-free' }] : []),
  ];
  if (!marks.length) {
    return null;
  }
  return (
    <View accessibilityLabel={marks.map((mark) => mark.label).join('. ')} style={styles.row}>
      {marks.map((mark) => (
        <Mark key={mark.kind} kind={mark.kind} label={mark.label} />
      ))}
    </View>
  );
}

function Mark({ kind, label }: { kind: MarkKind; label: string }) {
  const color = markColors[kind];
  return (
    <View style={styles.mark}>
      <Svg accessibilityLabel={label} height={34} viewBox="0 0 60 60" width={34}>
        <Circle cx="30" cy="30" fill="#FFFFFF" r="25" stroke={color} strokeWidth="4.5" />
        {kind === 'vegan' ? <VeganIcon color={color} /> : null}
        {kind === 'vegetarian' ? <VegetarianIcon color={color} /> : null}
        {kind === 'ketoFriendly' ? <KetoIcon color={color} /> : null}
        {kind === 'glutenFree' ? <GlutenFreeIcon color={color} /> : null}
      </Svg>
      <Text style={[styles.label, { color }]}>{label}</Text>
    </View>
  );
}

function VeganIcon({ color }: { color: string }) {
  return (
    <>
      <Path d="M29 44C15 41 12 29 14 17c12 1 19 10 18 24" fill={color} />
      <Path d="M31 44c1-14 9-23 19-27 1 13-3 24-17 27" fill={color} />
      <Line
        stroke="#FFFFFF"
        strokeLinecap="round"
        strokeWidth="1.8"
        x1="20"
        x2="31"
        y1="23"
        y2="43"
      />
      <Line
        stroke="#FFFFFF"
        strokeLinecap="round"
        strokeWidth="1.8"
        x1="43"
        x2="31"
        y1="23"
        y2="43"
      />
    </>
  );
}

function VegetarianIcon({ color }: { color: string }) {
  return (
    <>
      <Path d="M30 46c-8-7-10-16-7-26 6 2 10 7 10 14 0-7 4-12 10-14 3 10 1 19-7 26Z" fill={color} />
      <Path d="M30 45V28" fill="none" stroke="#FFFFFF" strokeLinecap="round" strokeWidth="2" />
      <Path d="M22 18c1-5 5-8 9-8-1 5-4 8-9 8ZM38 18c-1-5-5-8-9-8 1 5 4 8 9 8Z" fill={color} />
    </>
  );
}

function KetoIcon({ color }: { color: string }) {
  return (
    <>
      <Path
        d="M30 13 44 21v18L30 47 16 39V21Z"
        fill={color}
        opacity="0.16"
        stroke={color}
        strokeWidth="2"
      />
      <Line stroke={color} strokeLinecap="round" strokeWidth="3" x1="24" x2="24" y1="20" y2="40" />
      <Line stroke={color} strokeLinecap="round" strokeWidth="3" x1="25" x2="37" y1="30" y2="20" />
      <Line stroke={color} strokeLinecap="round" strokeWidth="3" x1="25" x2="38" y1="30" y2="40" />
    </>
  );
}

function GlutenFreeIcon({ color }: { color: string }) {
  return (
    <>
      <Line
        stroke={color}
        strokeLinecap="round"
        strokeWidth="2.3"
        x1="30"
        x2="30"
        y1="15"
        y2="45"
      />
      <Path
        d="M30 21c-7-1-8-6-7-9 5 1 8 4 7 9ZM30 27c-7-1-8-6-7-9 5 1 8 4 7 9ZM30 33c-7-1-8-6-7-9 5 1 8 4 7 9ZM30 21c7-1 8-6 7-9-5 1-8 4-7 9ZM30 27c7-1 8-6 7-9-5 1-8 4-7 9ZM30 33c7-1 8-6 7-9-5 1-8 4-7 9Z"
        fill={color}
      />
      <Line stroke={color} strokeLinecap="round" strokeWidth="5" x1="13" x2="47" y1="13" y2="47" />
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 14 },
  mark: { alignItems: 'center', flexDirection: 'row', gap: 5 },
  label: { fontSize: 11, fontWeight: '900', letterSpacing: 0.35, textTransform: 'uppercase' },
});
