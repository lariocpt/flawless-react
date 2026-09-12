import { Ionicons } from "@expo/vector-icons";
import { FlatList, Pressable, Text, TextInput, View } from "react-native";

interface NativeA11yCleanProps {
  onSave: () => void;
  onBack: () => void;
}

/**
 * The anti-vacuous control: every rule's precondition appears here SATISFIED,
 * so the analyser must report zero findings while the denominator proves it
 * examined 2 press targets, 1 text input and 4 icons. Zero-with-a-denominator
 * is the whole point of the wave — it is what the biome sweep could not say.
 */
export function NativeA11yClean({ onSave, onBack }: NativeA11yCleanProps) {
  // The tabBarIcon shape: an icon that is the ROOT of its JSX island, handed
  // to an owner this file cannot see (React Navigation's tab button announces
  // the tab title over it). The icon rule must stand down.
  const tabIcon = () => <Ionicons name="home-outline" size={20} />;
  void tabIcon;
  return (
    <View>
      <Pressable accessibilityLabel="Save profile" accessibilityRole="button" onPress={onSave}>
        <Text>Save profile</Text>
      </Pressable>
      <Pressable accessibilityLabel="Go back" accessibilityRole="button" onPress={onBack}>
        <Ionicons name="arrow-back" size={24} />
      </Pressable>
      <TextInput accessibilityLabel="Email" placeholder="you@example.com" />
      {/* hidden by its ancestor */}
      <View aria-hidden>
        <Ionicons name="sparkles" size={16} />
      </View>
      {/* hidden by itself */}
      <Ionicons aria-hidden name="star" size={16} />
      {/* attribute-position island: the FlatList decides where (and inside
          what) this renders, so the icon rule stands down */}
      <FlatList
        data={[]}
        renderItem={() => null}
        ListEmptyComponent={<Ionicons name="cloud-offline" size={20} />}
      />
    </View>
  );
}
