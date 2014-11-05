/** @jsx React.DOM */

var React = require('react');

var ScheduleComponent = require('components/Schedule.js');

React.renderComponent(
  <ScheduleComponent/>,
  document.getElementById('app')
);