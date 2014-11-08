 /** @jsx React.DOM */
 /**
 * @author Thefuture2092
 *
 */

'use strict'

define(["react", "app/trackdidia"], function(React, trackdidia){

	var ReactPropTypes = React.PropTypes;

	var SlotComponent = React.createClass({
		getInitialState : function() {
			return null;
		},

		componentDidMount: function() {

		},

		componentWillUnmount: function() {

		},

		render: function() {
			return (
				<div className="row">
					From {this.props.start} to {this.props.finish}
				</div>
				);
		}
	});

	return SlotComponent;
})