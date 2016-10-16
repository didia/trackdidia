/**
 * Created by didia on 16-10-15.
 */
import React from 'react';
import ReactDOM from 'react-dom';
import Home from '../Home';
import renderer from 'react-test-renderer';

it('renders without crashing', () => {
    const div = document.createElement('div');
    ReactDOM.render(<Home />, div);
});

it('has not unexpectedly changed', () => {
    const component = renderer.create(
        <Home />
    );
    let tree = component.toJSON();
    expect(tree).toMatchSnapshot();
});
