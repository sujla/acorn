exports.registerAsset = asset => ({
  uri: `/_acorn_assets/${asset.hash}-${asset.name}.${asset.type}`,
  width: asset.width, height: asset.height,
});
