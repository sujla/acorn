import React from 'react';
import { View, Text } from 'react-native-web';
export function BannerAd() {
  return <View style={{ padding: 8, alignItems: 'center', backgroundColor: '#edf0f3' }}><Text style={{ color: '#68727d', fontSize: 12 }}>Native ads · unavailable in web preview</Text></View>;
}
export const BannerAdSize = { ANCHORED_ADAPTIVE_BANNER: 'preview', BANNER: 'preview' };
export const TestIds = { ADAPTIVE_BANNER: 'preview', BANNER: 'preview' };
export default function mobileAds() { return { initialize: async () => { throw new Error('Native ads are unavailable in web preview.'); } }; }
