// Modify only presentation nodes in Stash's own ScenePage tree. The native
// editor and action callbacks retain the real first scene, never a virtual copy.
export function decorateScenePage(React, tree, group, firstScene, groupLink, summary) {
  const displayScene = { ...firstScene, details: group.synopsis || firstScene.details || '' };
  function walk(node, inDetails = false) {
    if (!React.isValidElement(node)) return node;
    const details = inDetails || node.props.eventKey === 'scene-details-panel';
    const changes = {};
    let children = node.props.children;
    if (children !== undefined) children = React.Children.map(children, child => walk(child, details));
    if (node.type === 'title') children = group.name;
    const classes = (node.props.className || '').split(' ');
    if (classes.includes('scene-header')) {
      children = React.Children.map(children, child => React.isValidElement(child) && 'text' in child.props ? React.cloneElement(child, { text: group.name }) : child);
    }
    if (classes.includes('scene-subheader')) {
      // Keep Stash's date / frame-rate row exactly as laid out by Stash.
      return React.createElement(React.Fragment, { key: node.key }, React.cloneElement(node, changes, children), React.createElement('div', { className: 'stitch-native-summary' }, summary, ' · ', groupLink));
    }
    if (details && node.props.scene?.id === firstScene.id) changes.scene = displayScene;
    if (node.props.eventKey === 'scene-edit-panel' && React.Children.toArray(node.props.children).some(child => React.isValidElement(child) && child.props.scene?.id === firstScene.id)) {
      children = [React.createElement('p', { key: 'stitch-edit-note', className: 'text-muted stitch-native-edit-note' }, 'This tab edits the first chapter. To change the group title or description: ', groupLink), ...React.Children.toArray(children)];
    }
    return children === undefined ? React.cloneElement(node, changes) : React.cloneElement(node, changes, children);
  }
  return walk(tree);
}
