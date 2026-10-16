import React, { forwardRef } from 'react';
import { StyleSheet } from 'react-native-web';
import { Unavailable } from './feature-boundary';
const denied = Object.freeze({ granted: false, status: 'denied', canAskAgain: false, expires: 'never' });
export const permission = async () => denied;
export const usePermission = () => [denied, permission, permission];
export const unavailable = () => { throw new Error('This native operation is unavailable in Acorn web preview.'); };
export const unavailableAsync = async () => unavailable();
export function component(feature) {
  return forwardRef(function NativeFeature(props, ref) {
    React.useImperativeHandle(ref, () => ({ takePictureAsync: unavailableAsync, recordAsync: unavailableAsync, stopRecording: unavailable, injectJavaScript: unavailable, reload: unavailable }));
    return <div style={StyleSheet.flatten(props.style)}><Unavailable feature={feature} /></div>;
  });
}
