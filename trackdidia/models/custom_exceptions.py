#!/usr/bin/env python
# -*- coding: utf-8 -*-
'''
Created on 2014-10-30

@author: didia
'''

class BadArgumentError(Exception):
    pass

class SchedulingConflict(Exception):
    pass

class SlotNotYetReached(Exception):
    pass

class HandlerException(Exception):
    pass

class RessourceNotFound(HandlerException):
    pass

class NotImplementedYet(HandlerException, NotImplementedError):
    pass

class DeleteTaskFailed(Exception):
    pass