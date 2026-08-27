import { useLocalSearchParams, useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { Icon } from "../../components/icon";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

export default function ItemDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  return (
    <SafeAreaView className="flex-1">
      <View className="flex-row p-4">
        {/* Icon-only: no testID, no accessibilityLabel, no text. Ionicons is in
            the closed textless table, so "nothing names this" is PROVABLE rather
            than guessed — and the same absence is what makes it silent to a
            screen reader. Its interaction test must be a skip that says so. */}
        <Pressable onPress={() => router.back()} className="p-2">
          <Ionicons name="chevron-back" size={24} />
        </Pressable>
        {/* Contrast: <Icon> is a LOCAL component. It may well render text, and
            we cannot see that from here — so it is unlabelled but NOT provably
            icon-only, and the skip says something weaker. */}
        <Pressable onPress={() => router.push("/signup")} className="p-2">
          <Icon name="forward" />
        </Pressable>
        <Text className="text-xl">Item {id}</Text>
      </View>
    </SafeAreaView>
  );
}
