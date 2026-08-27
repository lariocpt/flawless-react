import { useLocalSearchParams, useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Icon } from "../../components/icon";

export default function ItemDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  return (
    <SafeAreaView className="flex-1">
      <View className="flex-row p-4">
        {/* Icon-only: no testID, no accessibilityLabel, no text. Nothing names
            it, so its interaction test must be a skip that says so — and the
            same absence is what makes it silent to a screen reader. */}
        <Pressable onPress={() => router.back()} className="p-2">
          <Icon name="chevron-back" />
        </Pressable>
        <Text className="text-xl">Item {id}</Text>
      </View>
    </SafeAreaView>
  );
}
